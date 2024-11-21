const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const crypto = require('crypto');

const app = express();
const PORT = process.env.FUNCTIONCAT_RUNTIME_PORT || 3000;
const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const ALICLOUD_ACCESS_KEY_ID = process.env.ALICLOUD_ACCESS_KEY_ID;
const ALICLOUD_ACCESS_KEY_SECRET = process.env.ALICLOUD_ACCESS_KEY_SECRET;
const SYSTEM_URL = process.env.FUNCTIONCAT_SYSTEM_URL;
const STORE_SVC_API_KEY = process.env.STORE_SVC_API_KEY;

let baiduAccessToken = null;
let baiduTokenExpiry = null;

app.use(cors());
app.use(bodyParser.json());

// Function to get access token from Baidu
async function getBaiduAccessToken() {
  if (!baiduAccessToken || new Date() >= baiduTokenExpiry) {
    const response = await axios.post(`https://aip.baidubce.com/oauth/2.0/token`, null, {
      params: {
        grant_type: 'client_credentials',
        client_id: BAIDU_API_KEY,
        client_secret: BAIDU_SECRET_KEY,
      },
    });
    baiduAccessToken = response.data.access_token;
    baiduTokenExpiry = new Date(new Date().getTime() + response.data.expires_in * 1000);
  }
  return baiduAccessToken;
}

// Function to get signature for Alibaba Cloud API requests
function getAlibabaSignature(params, secret) {
  const sortedParams = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
  const stringToSign = `POST&%2F&${encodeURIComponent(sortedParams)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

// Function to get the current request count from the KV store
async function getRequestCount(dateKey) {
  try {
    const response = await axios.get(`${SYSTEM_URL}/svcs/store/namespaces/dailycounter/keys/${dateKey}`, {
      headers: {
        'API-KEY': STORE_SVC_API_KEY
      }
    });
    return response.data.value ? parseInt(response.data.value, 10) : 0;
  } catch (error) {
    // Handle case where the key does not exist
    if (error.response && error.response.status === 404) {
      console.log(`Key ${dateKey} not found, initializing count to 0.`);
      return 0; // Initialize count to 0 if key is not found
    }
    console.error('获取请求计数时出错:', error);
    throw error; // Re-throw the error for other cases
  }
}

// Function to update the request count in the KV store
async function updateRequestCount(dateKey, count) {
  console.log("updateRequestCount", dateKey, count)
  try {
    await axios.post(`${SYSTEM_URL}/svcs/store/namespaces/dailycounter/keys`, 
      { key: dateKey, value: count.toString() },  // Include both key and value in the body
      {
        headers: {
          'API-KEY': STORE_SVC_API_KEY
        }
      });
      console.log("updateRequestCount succeeded")
  } catch (error) {
    console.error('更新请求计数时出错:', error);
  }
}

// Middleware to check and update request count
async function rateLimitMiddleware(req, res, next) {
  const today = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format
  const dateKey = `requests-${today}`; // Use date-specific key for daily tracking

  const currentCount = await getRequestCount(dateKey);
  console.log("currentCount",dateKey, currentCount)
  const limit = 100;
  const remaining = limit - currentCount;

  if (remaining <= 0) {
    return res.status(429).json({ message: '请求已超出每日限制', remaining: 0, total: limit });
  }

  await updateRequestCount(dateKey, currentCount + 1);
  req.rateLimitInfo = { remaining: remaining - 1, total: limit };
  next();
}

app.get('/', async (req, res) => {
  const timestamp = new Date().toISOString();
  return res.json({ "message": "你好，我是chat-api", "timestamp": timestamp });
});

app.get('/v', async (req, res) => {
  return res.json("版本: 1");
});

app.post('/chat', rateLimitMiddleware, async (req, res) => {
  const { message, provider, model } = req.body;

  try {
    let ai_response;

    if (provider === 'baidu') {
      const accessToken = await getBaiduAccessToken();
      const response = await axios.post(
        `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/${model}?access_token=${accessToken}`,
        {
          messages: [{ role: "user", content: message }],
          temperature: 0.8,
          top_p: 0.8,
          penalty_score: 1,
          disable_search: false,
          enable_citation: false,
          collapsed: true
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      ai_response = response.data.result;

    } else if (provider === 'alicloud') {
      const params = {
        Action: 'GetResponse',
        Version: '2020-06-01',
        RegionId: 'cn-hangzhou',
        Text: message,
        ModelName: model,
        Timestamp: new Date().toISOString(),
        Format: 'JSON',
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        AccessKeyId: ALICLOUD_ACCESS_KEY_ID,
        SignatureNonce: Math.random().toString(36).substring(2)
      };

      params.Signature = getAlibabaSignature(params, ALICLOUD_ACCESS_KEY_SECRET);

      const response = await axios.post(
        'https://nlp.cn-hangzhou.aliyuncs.com/',
        null,
        { params }
      );

      ai_response = response.data.Response;

    } else {
      return res.status(400).send('指定的AI提供商无效');
    }

    res.json({ response: ai_response, remaining: req.rateLimitInfo.remaining, total: req.rateLimitInfo.total });

  } catch (error) {
    console.error('与AI提供商通信时出错:', error);
    res.status(500).send('与AI提供商通信时出错');
  }
});

app.listen(PORT, () => {
  console.log(`服务器正在端口 ${PORT} 上运行`);
});