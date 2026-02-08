import { loadDingTalkAxios } from "./deps.js";

const axios = loadDingTalkAxios();

const tokenCache = new Map<string, { accessToken: string; expiry: number }>();

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getStringField(data: unknown, field: string): string | undefined {
  const value = toRecord(data)?.[field];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(data: unknown, field: string): number | undefined {
  const value = toRecord(data)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
  const accessToken = getStringField(response.data, "accessToken");
  const expireIn = getNumberField(response.data, "expireIn");
  if (!accessToken || !expireIn) {
    throw new Error("Invalid DingTalk access token response");
  }
  tokenCache.set(config.clientId, {
    accessToken,
    expiry: now + expireIn * 1000,
  });
  return accessToken;
}

export async function getDingTalkOapiToken(config: {
  clientId: string;
  clientSecret: string;
}): Promise<string | null> {
  try {
    const resp = await axios.get("https://oapi.dingtalk.com/gettoken", {
      params: { appkey: config.clientId, appsecret: config.clientSecret },
    });
    const errcode = getNumberField(resp.data, "errcode");
    if (errcode === 0) {
      return getStringField(resp.data, "access_token") ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
