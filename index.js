const express = require('express');
const app = express()
const cors = require('cors')

require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 5000
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

//  const serviceAccount = require(
//   './zap-shift-cbe82-firebase-adminsdk.json'
// );

// const serviceAccount = require("./firebase-admin-key.json");


const serviceAccount = JSON.parse(
  Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
);

initializeApp({
  credential: cert(serviceAccount),
});



const crypto = require('crypto');
const generateTrackingId = () => {
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  const randomCode = crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()
    .slice(0, 6);

  return `ZPS-${date}-${randomCode}`;
};



// middleware
app.use(cors());
app.use(express.json());

const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  try {
    const idToken = authorization.split(' ')[1];

    const decoded = await getAuth().verifyIdToken(idToken);

    // console.log('Decoded token:', decoded);

    req.decoded_email = decoded.email;

    next();
  } catch (err) {
    console.error('Token verification error:', err.message);

    return res.status(401).send({
      message: 'Unauthorized access',
    });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zashygh.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const db = client.db('zap_shift_db');
    const userCollection = db.collection('users');
    const parcelsCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');
    const ridersCollection = db.collection('riders');



    // more middleware in database

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded_email;

        const user = await userCollection.findOne({ email });

        if (!user || user.role !== "admin") {
          return res.status(403).send({
            message: "forbidden access"
          });
        }

        next();

      } catch (error) {
        console.error("Admin verification error:", error);

        res.status(500).send({
          message: "Internal server error"
        });
      }
    };

    const verifyRider = async (req, res, next) => {
      try {
        const email = req.decoded_email;

        const user = await userCollection.findOne({ email });

        if (!user || user.role !== "rider") {
          return res.status(403).send({
            message: "forbidden access"
          });
        }

        next();

      } catch (error) {
        console.error("Rider verification error:", error);

        res.status(500).send({
          message: "Internal server error"
        });
      }
    };

    // rider earning: 80% of the cost inside the same district, 30% for different district
    const calcRiderEarning = (parcel) => {
      if (parcel.riderEarning !== undefined) {
        return parcel.riderEarning;
      }
      const cost = Number(parcel.cost) || 0;
      const rate = parcel.senderDistrict === parcel.receiverDistrict ? 0.8 : 0.3;
      return Math.round(cost * rate);
    };

    // last N days (oldest -> newest) as local yyyy-mm-dd keys with a short label
    const dayKey = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    const lastDays = (n = 7) => {
      const days = [];
      for (let i = n - 1; i >= 0; i--) {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - i);
        days.push({
          key: dayKey(date),
          label: date.toLocaleDateString('en-US', { weekday: 'short' }),
          date
        });
      }
      return days;
    };

    // user related api

    app.get('/users', verifyToken, async (req, res) => {

      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } }
        ];
      }
      const cursor = userCollection.find(query).sort({ createdAt: -1 }).limit(5);
      const result = await cursor.toArray();
      res.send(result)
    })

    app.get('/users/:id', async (req, res) => {

    })

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || 'user' })
    })

    app.post("/users", async (req, res) => {
      const user = req.body;

      const email = user.email;

      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        return res.send({
          message: "user exists",
        });
      }

      user.role = "user";
      user.createdAt = new Date();

      const result = await userCollection.insertOne(user);

      res.send(result);
    });

    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: roleInfo.role
        }
      }
      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result)
    })


    //parcel api

    app.get('/parcels', async (req, res) => {
      const { email, deliveryStatus } = req.query;

      const query = {};

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus
      }
      const options = { sort: { createdAt: -1 } }
      const result = await parcelsCollection.find(query, options).toArray();

      res.send(result);
    });

    app.get('/parcels/rider', verifyToken, verifyRider, async (req, res) => {
      const { deliveryStatus } = req.query;

      // a rider can only read his own parcels
      const query = { riderEmail: req.decoded_email };

      // deliveryStatus can be one status or a comma separated list
      if (deliveryStatus) {
        query.deliveryStatus = { $in: deliveryStatus.split(',') }
      }
      const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result)
    })

    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date()
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result)
    })


    app.patch('/parcels/:id', async (req, res) => {
      const { riderId, riderName, riderEmail } = req.body;
      const id = req.params.id
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: 'driver-assigned',
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail
        }
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc);

      // update rider information

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: 'in-delivery'
        }
      }
      const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);

      res.send(riderResult)
    })

    // rider delivery flow : driver-assigned -> rider_ariving -> picked-up -> in-transit -> delivered
    const riderFlow = ['driver-assigned', 'rider_ariving', 'picked-up', 'in-transit', 'delivered'];

    app.patch('/parcels/:id/status', verifyToken, verifyRider, async (req, res) => {
      const { deliveryStatus } = req.body

      if (!riderFlow.includes(deliveryStatus)) {
        return res.status(400).send({ message: 'Invalid delivery status' })
      }

      // only the assigned rider can move his own parcel
      const query = { _id: new ObjectId(req.params.id), riderEmail: req.decoded_email }
      const parcel = await parcelsCollection.findOne(query);

      if (!parcel) {
        return res.status(404).send({ message: 'Parcel not found for this rider' })
      }

      const now = new Date();
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
          updatedAt: now
        },
        $push: {
          trackingLog: { status: deliveryStatus, at: now }
        }
      }

      if (deliveryStatus === 'delivered') {
        updatedDoc.$set.deliveredAt = now;
        updatedDoc.$set.riderEarning = calcRiderEarning(parcel);
      }

      const result = await parcelsCollection.updateOne(query, updatedDoc);

      // rider is free again after the delivery
      if (deliveryStatus === 'delivered') {
        await ridersCollection.updateOne(
          { email: req.decoded_email },
          { $set: { workStatus: 'available' } }
        );
      }

      res.send(result)
    })

    // rider rejects an assigned parcel -> goes back to the admin for re-assign
    app.patch('/parcels/:id/reject', verifyToken, verifyRider, async (req, res) => {
      const query = {
        _id: new ObjectId(req.params.id),
        riderEmail: req.decoded_email,
        deliveryStatus: 'driver-assigned'
      }

      const updatedDoc = {
        $set: {
          deliveryStatus: 'pending-pickup',
          updatedAt: new Date()
        },
        $unset: {
          riderId: '',
          riderName: '',
          riderEmail: ''
        }
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc);

      if (result.modifiedCount) {
        await ridersCollection.updateOne(
          { email: req.decoded_email },
          { $set: { workStatus: 'available' } }
        );
      }

      res.send(result)
    })

    // delete my parcels

    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await parcelsCollection.deleteOne(query);
      res.send(result)
    })

    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await parcelsCollection.findOne(query);
      res.send(result)
    })



    // payment apis
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              }
            },

            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      });


      res.send({ url: session.url })
    });


    app.patch('/payment-success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (!sessionId) {
          return res.status(400).send({
            success: false,
            message: 'Session ID is required'
          });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const transactionId = session.payment_intent;

        if (session.payment_status !== 'paid') {
          return res.status(400).send({
            success: false,
            message: 'Payment is not completed'
          });
        }

        if (!session.metadata?.parcelId || !transactionId) {
          return res.status(400).send({
            success: false,
            message: 'Invalid payment session'
          });
        }

        // Prevent duplicate payment records
        const paymentExist = await paymentCollection.findOne({
          transactionId: transactionId
        });

        if (paymentExist) {
          return res.send({
            success: true,
            message: 'Payment already exists',
            transactionId,
            trackingID: paymentExist.trackingID
          });
        }

        const trackingID = generateTrackingId();
        const parcelId = session.metadata.parcelId;

        // Update parcel and wait for the database result
        const parcelResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: 'paid',
              deliveryStatus: 'pending-pickup',
              trackingID: trackingID
            }
          }
        );

        if (parcelResult.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: 'Parcel not found'
          });
        }

        const payment = {
          amountTotal: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: transactionId,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingID: trackingID
        };

        const paymentResult = await paymentCollection.insertOne(payment);

        // Send exactly one success response
        return res.send({
          success: true,
          trackingID,
          transactionId,
          modifyParcel: parcelResult,
          paymentInfo: paymentResult
        });

      } catch (error) {
        console.error('Payment success error:', error.message);

        if (res.headersSent) {
          return;
        }

        return res.status(500).send({
          success: false,
          message: 'Failed to process payment'
        });
      }
    });

    // payment related api
    app.get('/payments', verifyToken, async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({
          message: 'Email is required',
        });
      }

      // Check requested email with Firebase decoded email
      if (email !== req.decoded_email) {
        return res.status(403).send({
          message: 'Forbidden access',
        });
      }

      const query = {
        customerEmail: email,
      };

      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();

      res.send(result);
    });


    // rider related api
    app.get('/riders', async (req, res) => {
      //console.log('Query:', req.query);
      const { status, district, workStatus } = req.query;
      const query = {};

      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district
      }
      if (workStatus) {
        query.workStatus = workStatus
      }

      //console.log('Mongo Query:', query);
      const cursor = ridersCollection
        .find(query)
        .sort({ createdAt: -1 });

      const result = await cursor.toArray();

      res.send(result);
    });

    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result)
    })

    app.patch('/riders/:id', verifyToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: 'available'
        }
      }
      const result = await ridersCollection.updateOne(query, updatedDoc);

      if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email }
        const updateUser = {
          $set: {
            role: 'rider'
          }
        }
        const userResult = await userCollection.updateOne(userQuery, updateUser)
      }
      res.send(result)
    })

    // dashboard home stats (one api for each role)

    app.get('/stats/admin', verifyToken, verifyAdmin, async (req, res) => {
      const [totalUsers, totalRiders, pendingRiders, totalParcels] = await Promise.all([
        userCollection.countDocuments(),
        ridersCollection.countDocuments({ status: 'approved' }),
        ridersCollection.countDocuments({ status: 'pending' }),
        parcelsCollection.countDocuments()
      ]);

      const statusAgg = await parcelsCollection
        .aggregate([{ $group: { _id: '$deliveryStatus', count: { $sum: 1 } } }])
        .toArray();

      const statusCount = {};
      statusAgg.forEach(item => {
        statusCount[item._id || 'unpaid'] = item.count;
      });

      const revenueAgg = await paymentCollection
        .aggregate([{ $group: { _id: null, total: { $sum: '$amountTotal' }, count: { $sum: 1 } } }])
        .toArray();

      // last 7 days chart data
      const days = lastDays(7);
      const since = days[0].date;

      const recentPayments = await paymentCollection.find({ paidAt: { $gte: since } }).toArray();
      const recentParcels = await parcelsCollection
        .find({ createdAt: { $gte: since } })
        .project({ createdAt: 1 })
        .toArray();

      const daily = days.map(day => ({
        label: day.label,
        revenue: recentPayments
          .filter(p => dayKey(new Date(p.paidAt)) === day.key)
          .reduce((sum, p) => sum + (p.amountTotal || 0), 0),
        parcels: recentParcels.filter(p => dayKey(new Date(p.createdAt)) === day.key).length
      }));

      const latestParcels = await parcelsCollection
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .project({ parcelName: 1, senderName: 1, senderDistrict: 1, receiverDistrict: 1, cost: 1, deliveryStatus: 1, createdAt: 1 })
        .toArray();

      const deliveredParcels = await parcelsCollection
        .find({ deliveryStatus: 'delivered', riderEmail: { $exists: true } })
        .toArray();

      const riderMap = {};
      deliveredParcels.forEach(parcel => {
        const key = parcel.riderEmail;
        if (!riderMap[key]) {
          riderMap[key] = { name: parcel.riderName, email: key, deliveries: 0, earning: 0 };
        }
        riderMap[key].deliveries += 1;
        riderMap[key].earning += calcRiderEarning(parcel);
      });
      const topRiders = Object.values(riderMap)
        .sort((a, b) => b.deliveries - a.deliveries)
        .slice(0, 3);

      res.send({
        totalUsers,
        totalRiders,
        pendingRiders,
        totalParcels,
        revenue: revenueAgg[0]?.total || 0,
        paymentCount: revenueAgg[0]?.count || 0,
        statusCount,
        daily,
        latestParcels,
        topRiders
      });
    })

    app.get('/stats/rider', verifyToken, verifyRider, async (req, res) => {
      const email = req.decoded_email;

      const rider = await ridersCollection.findOne({ email });
      const parcels = await parcelsCollection
        .find({ riderEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

      const statusCount = {};
      parcels.forEach(parcel => {
        const status = parcel.deliveryStatus || 'unknown';
        statusCount[status] = (statusCount[status] || 0) + 1;
      });

      const delivered = parcels.filter(p => p.deliveryStatus === 'delivered');
      const activeStatuses = ['driver-assigned', 'rider_ariving', 'picked-up', 'in-transit'];
      const activeParcels = parcels.filter(p => activeStatuses.includes(p.deliveryStatus));

      const totalEarning = delivered.reduce((sum, p) => sum + calcRiderEarning(p), 0);

      const days = lastDays(7);
      const daily = days.map(day => {
        const dayParcels = delivered.filter(p => p.deliveredAt && dayKey(new Date(p.deliveredAt)) === day.key);
        return {
          label: day.label,
          deliveries: dayParcels.length,
          earning: dayParcels.reduce((sum, p) => sum + calcRiderEarning(p), 0)
        };
      });

      const todayKey = dayKey(new Date());
      const todayEarning = daily[daily.length - 1].earning;

      res.send({
        rider: {
          name: rider?.name,
          district: rider?.district,
          workStatus: rider?.workStatus || 'available',
          bikeInfo: rider?.bikeInfo
        },
        statusCount,
        totalAssigned: parcels.length,
        totalDelivered: delivered.length,
        totalEarning,
        todayEarning,
        todayKey,
        daily,
        activeParcels: activeParcels.slice(0, 4),
        recentDelivered: delivered.slice(0, 5)
      });
    })

    app.get('/stats/user', verifyToken, async (req, res) => {
      const email = req.decoded_email;

      const parcels = await parcelsCollection
        .find({ senderEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

      const statusCount = {};
      parcels.forEach(parcel => {
        const status = parcel.deliveryStatus || 'unpaid';
        statusCount[status] = (statusCount[status] || 0) + 1;
      });

      const unpaidParcels = parcels.filter(p => p.paymentStatus !== 'paid');
      const totalSpent = parcels
        .filter(p => p.paymentStatus === 'paid')
        .reduce((sum, p) => sum + (Number(p.cost) || 0), 0);

      const riderApplication = await ridersCollection.findOne({ email });

      res.send({
        totalParcels: parcels.length,
        delivered: statusCount['delivered'] || 0,
        unpaidCount: unpaidParcels.length,
        unpaidAmount: unpaidParcels.reduce((sum, p) => sum + (Number(p.cost) || 0), 0),
        totalSpent,
        statusCount,
        riderStatus: riderApplication?.status || null,
        latestParcels: parcels.slice(0, 4)
      });
    })

    //await client.db("admin").command({ ping: 1 });
    //console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    //await client.close();
  }
}
// Root route
app.get('/', (req, res) => {
  res.send('zap is shifting');
});

// Initialize MongoDB and register all API routes
const initPromise = run();

// Local development: node index.js
if (require.main === module) {
  initPromise
    .then(() => {
      app.listen(port, () => {
        console.log(`Zap Shift server running on port ${port}`);
      });
    })
    .catch((error) => {
      console.error('Server initialization failed:', error);
      process.exit(1);
    });
} else {
  // Vercel serverless handler
  module.exports = async (req, res) => {
    try {
      await initPromise;
      return app(req, res);
    } catch (error) {
      console.error('API initialization error:', error);

      if (!res.headersSent) {
        return res.status(500).json({
          message: 'Server initialization failed'
        });
      }
    }
  };
}