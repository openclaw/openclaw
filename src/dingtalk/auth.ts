import { loadDingTalkAxios } from "./deps.js";

const axios = loadDingTalkAxios();

let accessToken: string | null = null;
let accessTokenExpiry = 0;

export async function getDingTalkAccessToken(config: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60_000) {
    return accessToken;
  }
  const response = await axios.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    appKey: config.clientId,
    appSecret: config.clientSecret,
  });
  accessToken = response.data.accessToken;
  accessTokenExpiry = now + response.data.expireIn * 1000;
  return accessToken!;
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
