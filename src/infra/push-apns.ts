import { createHash, createPrivateKey, sign as signJwt } from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsRegistration = {
  nodeId: string;
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  updatedAtMs: number;
};

export type ApnsAuthConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
};

export type ApnsAuthConfigResolution =
  | { ok: true; value: ApnsAuthConfig }
  | { ok: false; error: string };

export type ApnsPushAlertResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  tokenSuffix: string;
  topic: string;
  environment: ApnsEnvironment;
};

export type ApnsPushWakeResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  tokenSuffix: string;
  topic: string;
  environment: ApnsEnvironment;
};

type ApnsPushType = "alert" | "background";

type ApnsRequestParams = {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
};

type ApnsRequestResponse = { status: number; apnsId?: string; body: string };

type ApnsRequestSender = (params: ApnsRequestParams) => Promise<ApnsRequestResponse>;

type ApnsRegistrationState = {
  registrationsByNodeId: Record<string, ApnsRegistration>;
};

const APNS_STATE_FILENAME = "push/apns-registrations.json";
const APNS_JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_APNS_TIMEOUT_MS = 10_000;
const withLock = createAsyncLock();

let cachedJwt: { cacheKey: string; token: string; expiresAtMs: number } | null = null;

function resolveApnsRegistrationPath(baseDir?: string): string {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, APNS_STATE_FILENAME);
}

function normalizeNodeId(value: string): string {
  return value.trim();
}

function normalizeApnsToken(value: string): string {
  return value
    .trim()
    .replace(/[<>\s]/g, "")
    .toLowerCase();
}

function normalizeTopic(value: string): string {
  return value.trim();
}

function isLikelyApnsToken(value: string): boolean {
  return /^[0-9a-f]{32,}$/i.test(value);
}

function parseReason(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : trimmed.slice(0, 200);
  } catch {
    return trimmed.slice(0, 200);
  }
}

function toBase64UrlBytes(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toBase64UrlJson(value: object): string {
  return toBase64UrlBytes(Buffer.from(JSON.stringify(value)));
}

function getJwtCacheKey(auth: ApnsAuthConfig): string {
  const keyHash = createHash("sha256").update(auth.privateKey).digest("hex");
  return `${auth.teamId}:${auth.keyId}:${keyHash}`;
}

function getApnsBearerToken(auth: ApnsAuthConfig, nowMs: number = Date.now()): string {
  const cacheKey = getJwtCacheKey(auth);
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowMs < cachedJwt.expiresAtMs) {
    return cachedJwt.token;
  }

  const iat = Math.floor(nowMs / 1000);
  const header = toBase64UrlJson({ alg: "ES256", kid: auth.keyId, typ: "JWT" });
  const payload = toBase64UrlJson({ iss: auth.teamId, iat });
  const signingInput = `${header}.${payload}`;
  const signature = signJwt("sha256", Buffer.from(signingInput, "utf8"), {
    key: createPrivateKey(auth.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const token = `${signingInput}.${toBase64UrlBytes(signature)}`;
  cachedJwt = {
    cacheKey,
    token,
    expiresAtMs: nowMs + APNS_JWT_TTL_MS,
  };
  return token;
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

async function loadRegistrationsState(baseDir?: string): Promise<ApnsRegistrationState> {
  const filePath = resolveApnsRegistrationPath(baseDir);
  const existing = await readJsonFile<ApnsRegistrationState>(filePath);
  if (!existing || typeof existing !== "object") {
    return { registrationsByNodeId: {} };
  }
  const registrations =
    existing.registrationsByNodeId &&
    typeof existing.registrationsByNodeId === "object" &&
    !Array.isArray(existing.registrationsByNodeId)
      ? existing.registrationsByNodeId
      : {};
  return { registrationsByNodeId: registrations };
}

async function persistRegistrationsState(
  state: ApnsRegistrationState,
  baseDir?: string,
): Promise<void> {
  const filePath = resolveApnsRegistrationPath(baseDir);
  await writeJsonAtomic(filePath, state);
}

export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return null;
}

export async function registerApnsToken(params: {
  nodeId: string;
  token: string;
  topic: string;
  environment?: unknown;
  baseDir?: string;
}): Promise<ApnsRegistration> {
  const nodeId = normalizeNodeId(params.nodeId);
  const token = normalizeApnsToken(params.token);
  const topic = normalizeTopic(params.topic);
  const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";

  if (!nodeId) {
    throw new Error("nodeId required");
  }
  if (!topic) {
    throw new Error("topic required");
  }
  if (!isLikelyApnsToken(token)) {
    throw new Error("invalid APNs token");
  }

  return await withLock(async () => {
    const state = await loadRegistrationsState(params.baseDir);
    const next: ApnsRegistration = {
      nodeId,
      token,
      topic,
      environment,
      updatedAtMs: Date.now(),
    };
    state.registrationsByNodeId[nodeId] = next;
    await persistRegistrationsState(state, params.baseDir);
    return next;
  });
}

export async function loadApnsRegistration(
  nodeId: string,
  baseDir?: string,
): Promise<ApnsRegistration | null> {
  const normalizedNodeId = normalizeNodeId(nodeId);
  if (!normalizedNodeId) {
    return null;
  }
  const state = await loadRegistrationsState(baseDir);
  return state.registrationsByNodeId[normalizedNodeId] ?? null;
}

export async function resolveApnsAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApnsAuthConfigResolution> {
  const teamId = normalizeNonEmptyString(env.OPENCLAW_APNS_TEAM_ID);
  const keyId = normalizeNonEmptyString(env.OPENCLAW_APNS_KEY_ID);
  if (!teamId || !keyId) {
    return {
      ok: false,
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
    };
  }

  const inlineKeyRaw =
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_P8) ??
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY);
  if (inlineKeyRaw) {
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey: normalizePrivateKey(inlineKeyRaw),
      },
    };
  }

  const keyPath = normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_PATH);
  if (!keyPath) {
    return {
      ok: false,
      error:
        "APNs private key missing: set OPENCLAW_APNS_PRIVATE_KEY_P8 or OPENCLAW_APNS_PRIVATE_KEY_PATH",
    };
  }
  try {
    const privateKey = normalizePrivateKey(await fs.readFile(keyPath, "utf8"));
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${keyPath}): ${message}`,
    };
  }
}

async function sendApnsRequest(params: {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsRequestResponse> {
  const authority =
    params.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const body = JSON.stringify(params.payload);
  const requestPath = `/3/device/${params.token}`;

  return await new Promise((resolve, reject) => {
    const client = http2.connect(authority);
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      client.destroy();
      reject(err);
    };
    const finish = (result: { status: number; apnsId?: string; body: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      client.close();
      resolve(result);
    };

    client.once("error", (err) => fail(err));

    const req = client.request({
      ":method": "POST",
      ":path": requestPath,
      authorization: `bearer ${params.bearerToken}`,
      "apns-topic": params.topic,
      "apns-push-type": params.pushType,
      "apns-priority": params.priority,
      "apns-expiration": "0",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
    });

    let statusCode = 0;
    let apnsId: string | undefined;
    let responseBody = "";

    req.setEncoding("utf8");
    req.setTimeout(params.timeoutMs, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      fail(new Error(`APNs request timed out after ${params.timeoutMs}ms`));
    });
    req.on("response", (headers) => {
      const statusHeader = headers[":status"];
      statusCode = typeof statusHeader === "number" ? statusHeader : Number(statusHeader ?? 0);
      const idHeader = headers["apns-id"];
      if (typeof idHeader === "string" && idHeader.trim().length > 0) {
        apnsId = idHeader.trim();
      }
    });
    req.on("data", (chunk) => {
      if (typeof chunk === "string") {
        responseBody += chunk;
      }
    });
    req.on("end", () => {
      finish({ status: statusCode, apnsId, body: responseBody });
    });
    req.on("error", (err) => fail(err));

    req.end(body);
  });
}

function resolveApnsTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1000, Math.trunc(timeoutMs))
    : DEFAULT_APNS_TIMEOUT_MS;
}

function resolveApnsSendContext(params: { auth: ApnsAuthConfig; registration: ApnsRegistration }): {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
} {
  const token = normalizeApnsToken(params.registration.token);
  if (!isLikelyApnsToken(token)) {
    throw new Error("invalid APNs token");
  }
  const topic = normalizeTopic(params.registration.topic);
  if (!topic) {
    throw new Error("topic required");
  }
  return {
    token,
    topic,
    environment: params.registration.environment,
    bearerToken: getApnsBearerToken(params.auth),
  };
}

function toApnsPushResult(params: {
  response: ApnsRequestResponse;
  token: string;
  topic: string;
  environment: ApnsEnvironment;
}): ApnsPushWakeResult {
  return {
    ok: params.response.status === 200,
    status: params.response.status,
    apnsId: params.response.apnsId,
    reason: parseReason(params.response.body),
    tokenSuffix: params.token.slice(-8),
    topic: params.topic,
    environment: params.environment,
  };
}

function createOpenClawPushMetadata(params: {
  kind: "push.test" | "node.wake";
  nodeId: string;
  reason?: string;
}): { kind: "push.test" | "node.wake"; nodeId: string; ts: number; reason?: string } {
  return {
    kind: params.kind,
    nodeId: params.nodeId,
    ts: Date.now(),
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

async function sendApnsPush(params: {
  auth: ApnsAuthConfig;
  registration: ApnsRegistration;
  payload: object;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsPushWakeResult> {
  const { token, topic, environment, bearerToken } = resolveApnsSendContext({
    auth: params.auth,
    registration: params.registration,
  });
  const sender = params.requestSender ?? sendApnsRequest;
  const response = await sender({
    token,
    topic,
    environment,
    bearerToken,
    payload: params.payload,
    timeoutMs: resolveApnsTimeoutMs(params.timeoutMs),
    pushType: params.pushType,
    priority: params.priority,
  });
  return toApnsPushResult({ response, token, topic, environment });
}

export async function sendApnsAlert(params: {
  auth: ApnsAuthConfig;
  registration: ApnsRegistration;
  nodeId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
}): Promise<ApnsPushAlertResult> {
  const payload = {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
    },
    openclaw: createOpenClawPushMetadata({
      kind: "push.test",
      nodeId: params.nodeId,
    }),
  };

  return await sendApnsPush({
    auth: params.auth,
    registration: params.registration,
    payload,
    timeoutMs: params.timeoutMs,
    requestSender: params.requestSender,
    pushType: "alert",
    priority: "10",
  });
}

export async function sendApnsBackgroundWake(params: {
  auth: ApnsAuthConfig;
  registration: ApnsRegistration;
  nodeId: string;
  wakeReason?: string;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
}): Promise<ApnsPushWakeResult> {
  const payload = {
    aps: {
      "content-available": 1,
    },
    openclaw: createOpenClawPushMetadata({
      kind: "node.wake",
      reason: params.wakeReason ?? "node.invoke",
      nodeId: params.nodeId,
    }),
  };
  return await sendApnsPush({
    auth: params.auth,
    registration: params.registration,
    payload,
    timeoutMs: params.timeoutMs,
    requestSender: params.requestSender,
    pushType: "background",
    priority: "5",
  });
}
