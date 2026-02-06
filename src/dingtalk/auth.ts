import { loadDingTalkAxios } from "./deps.js";

const axios = loadDingTalkAxios();

const tokenCache = new Map<string, { accessToken: string; expiry: number }>();

export async function getDingTalkAccessToken(config: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(config.clientId);
  if (cached && cached.expiry > now + 60_000) {
    return cached.accessToken;
  }
  const response = await axios.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    appKey: config.clientId,
    appSecret: config.clientSecret,
  });
  tokenCache.set(config.clientId, {
    accessToken: response.data.accessToken,
    expiry: now + response.data.expireIn * 1000,
  });
  return response.data.accessToken;
}

export async function getDingTalkOapiToken(config: {
  clientId: string;
  clientSecret: string;
}): Promise<string | null> {
  try {
    const resp = await axios.get("https://oapi.dingtalk.com/gettoken", {
      params: { appkey: config.clientId, appsecret: config.clientSecret },
    });
    if (resp.data?.errcode === 0) {
      return resp.data.access_token;
    }
    return null;
  } catch {
    return null;
  }
}
