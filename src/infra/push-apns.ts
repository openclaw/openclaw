import { createHash, createPrivateKey, sign as signJwt } from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
import {
  type ApnsRelayConfig,
  type ApnsRelayConfigResolution,
  type ApnsRelayPushResponse,
  type ApnsRelayRequestSender,
  resolveApnsRelayConfigFromEnv,
  sendApnsRelayPush,
} from "./push-apns.relay.js";

export type ApnsEnvironment = "sandbox" | "production";
export type ApnsTransport = "direct" | "relay";

export type DirectApnsRegistration = {
  nodeId: string;
  transport: "direct";
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  updatedAtMs: number;
};

export type RelayApnsRegistration = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  installationId: string;
  topic: string;
  environment: "production";
  distribution: "official";
  updatedAtMs: number;
  tokenDebugSuffix?: string;
};

export type ApnsRegistration = DirectApnsRegistration | RelayApnsRegistration;

export type ApnsAuthConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
};

export type ApnsAuthConfigResolution =
  | { ok: true; value: ApnsAuthConfig }
  | { ok: false; error: string };

export type ApnsPushResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  tokenSuffix: string;
  topic: string;
  environment: ApnsEnvironment;
  transport: ApnsTransport;
};

export type ApnsPushAlertResult = ApnsPushResult;
export type ApnsPushWakeResult = ApnsPushResult;

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

type RegisterDirectApnsParams = {
  nodeId: string;
  transport?: "direct";
  token: string;
  topic: string;
  environment?: unknown;
  baseDir?: string;
};

type RegisterRelayApnsParams = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  installationId: string;
  topic: string;
  environment?: unknown;
  distribution?: unknown;
  tokenDebugSuffix?: unknown;
  baseDir?: string;
};

type RegisterApnsParams = RegisterDirectApnsParams | RegisterRelayApnsParams;

const APNS_STATE_FILENAME = "push/apns-registrations.json";
const APNS_JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_APNS_TIMEOUT_MS = 10_000;
const MAX_RELAY_IDENTIFIER_LENGTH = 256;
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

function normalizeRelayHandle(value: string): string {
  return value.trim();
}

function normalizeInstallationId(value: string): string {
  return value.trim();
}

function validateRelayIdentifier(value: string, fieldName: string): string {
  if (!value) {
    throw new Error(`${fieldName} required`);
  }
  if (value.length > MAX_RELAY_IDENTIFIER_LENGTH) {
    throw new Error(`${fieldName} too long`);
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${fieldName} invalid`);
  }
  return value;
}

function normalizeTopic(value: string): string {
  return value.trim();
}

function normalizeTokenDebugSuffix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "");
  return normalized.length > 0 ? normalized.slice(-8) : undefined;
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

function normalizeDistribution(value: unknown): "official" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "official" ? "official" : null;
}

function normalizeDirectRegistration(
  record: Partial<DirectApnsRegistration> & { nodeId?: unknown; token?: unknown },
): DirectApnsRegistration | null {
  if (typeof record.nodeId !== "string" || typeof record.token !== "string") {
    return null;
  }
  const nodeId = normalizeNodeId(record.nodeId);
  const token = normalizeApnsToken(record.token);
  const topic = normalizeTopic(typeof record.topic === "string" ? record.topic : "");
  const environment = normalizeApnsEnvironment(record.environment) ?? "sandbox";
  const updatedAtMs =
    typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)
      ? Math.trunc(record.updatedAtMs)
      : 0;
  if (!nodeId || !topic || !isLikelyApnsToken(token)) {
    return null;
  }
  return {
    nodeId,
    transport: "direct",
    token,
    topic,
    environment,
    updatedAtMs,
  };
}

function normalizeRelayRegistration(
  record: Partial<RelayApnsRegistration> & { nodeId?: unknown; relayHandle?: unknown },
): RelayApnsRegistration | null {
  if (
    typeof record.nodeId !== "string" ||
    typeof record.relayHandle !== "string" ||
    typeof record.installationId !== "string"
  ) {
    return null;
  }
  const nodeId = normalizeNodeId(record.nodeId);
  const relayHandle = normalizeRelayHandle(record.relayHandle);
  const installationId = normalizeInstallationId(record.installationId);
  const topic = normalizeTopic(typeof record.topic === "string" ? record.topic : "");
  const environment = normalizeApnsEnvironment(record.environment);
  const distribution = normalizeDistribution(record.distribution);
  const updatedAtMs =
    typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)
      ? Math.trunc(record.updatedAtMs)
      : 0;
  if (
    !nodeId ||
    !relayHandle ||
    !installationId ||
    !topic ||
    environment !== "production" ||
    distribution !== "official"
  ) {
    return null;
  }
  return {
    nodeId,
    transport: "relay",
    relayHandle,
    installationId,
    topic,
    environment,
    distribution,
    updatedAtMs,
    tokenDebugSuffix: normalizeTokenDebugSuffix(record.tokenDebugSuffix),
  };
}

function normalizeStoredRegistration(record: unknown): ApnsRegistration | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const candidate = record as Record<string, unknown>;
  const transport =
    typeof candidate.transport === "string" ? candidate.transport.trim().toLowerCase() : "direct";
  if (transport === "relay") {
    return normalizeRelayRegistration(candidate as Partial<RelayApnsRegistration>);
  }
  return normalizeDirectRegistration(candidate as Partial<DirectApnsRegistration>);
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
  const normalized: Record<string, ApnsRegistration> = {};
  for (const [nodeId, record] of Object.entries(registrations)) {
    const registration = normalizeStoredRegistration(record);
    if (registration) {
      normalized[normalizeNodeId(nodeId)] = registration;
    }
  }
  return { registrationsByNodeId: normalized };
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

export async function registerApnsRegistration(
  params: RegisterApnsParams,
): Promise<ApnsRegistration> {
  const nodeId = normalizeNodeId(params.nodeId);
  const topic = normalizeTopic(params.topic);
  if (!nodeId) {
    throw new Error("nodeId required");
  }
  if (!topic) {
    throw new Error("topic required");
  }

  return await withLock(async () => {
    const state = await loadRegistrationsState(params.baseDir);
    const updatedAtMs = Date.now();

    let next: ApnsRegistration;
    if (params.transport === "relay") {
      const relayHandle = validateRelayIdentifier(
        normalizeRelayHandle(params.relayHandle),
        "relayHandle",
      );
      const installationId = validateRelayIdentifier(
        normalizeInstallationId(params.installationId),
        "installationId",
      );
      const environment = normalizeApnsEnvironment(params.environment);
      const distribution = normalizeDistribution(params.distribution);
      if (environment !== "production") {
        throw new Error("relay registrations must use production environment");
      }
      if (distribution !== "official") {
        throw new Error("relay registrations must use official distribution");
      }
      next = {
        nodeId,
        transport: "relay",
        relayHandle,
        installationId,
        topic,
        environment,
        distribution,
        updatedAtMs,
        tokenDebugSuffix: normalizeTokenDebugSuffix(params.tokenDebugSuffix),
      };
    } else {
      const token = normalizeApnsToken(params.token);
      const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";
      if (!isLikelyApnsToken(token)) {
        throw new Error("invalid APNs token");
      }
      next = {
        nodeId,
        transport: "direct",
        token,
        topic,
        environment,
        updatedAtMs,
      };
    }

    state.registrationsByNodeId[nodeId] = next;
    await persistRegistrationsState(state, params.baseDir);
    return next;
  });
}

export async function registerApnsToken(params: {
  nodeId: string;
  token: string;
  topic: string;
  environment?: unknown;
  baseDir?: string;
}): Promise<DirectApnsRegistration> {
  return (await registerApnsRegistration({
    ...params,
    transport: "direct",
  })) as DirectApnsRegistration;
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

export async function clearApnsRegistration(nodeId: string, baseDir?: string): Promise<boolean> {
  const normalizedNodeId = normalizeNodeId(nodeId);
  if (!normalizedNodeId) {
    return false;
  }
  return await withLock(async () => {
    const state = await loadRegistrationsState(baseDir);
    if (!(normalizedNodeId in state.registrationsByNodeId)) {
      return false;
    }
    delete state.registrationsByNodeId[normalizedNodeId];
    await persistRegistrationsState(state, baseDir);
    return true;
  });
}

export function shouldInvalidateApnsRegistration(result: {
  status: number;
  reason?: string;
}): boolean {
  if (result.status === 410) {
    return true;
  }
  return result.status === 400 && result.reason?.trim() === "BadDeviceToken";
}

export function shouldClearStoredApnsRegistration(params: {
  registration: ApnsRegistration;
  result: { status: number; reason?: string };
  overrideEnvironment?: ApnsEnvironment | null;
}): boolean {
  if (params.registration.transport !== "direct") {
    return false;
  }
  if (
    params.overrideEnvironment &&
    params.overrideEnvironment !== params.registration.environment
  ) {
    return false;
  }
  return shouldInvalidateApnsRegistration(params.result);
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

function resolveDirectSendContext(params: {
  auth: ApnsAuthConfig;
  registration: DirectApnsRegistration;
}): {
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

function toPushMetadata(params: {
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

function resolveRegistrationDebugSuffix(
  registration: ApnsRegistration,
  relayResult?: Pick<ApnsRelayPushResponse, "tokenSuffix">,
): string {
  if (registration.transport === "direct") {
    return registration.token.slice(-8);
  }
  return (
    relayResult?.tokenSuffix ?? registration.tokenDebugSuffix ?? registration.relayHandle.slice(-8)
  );
}

function toPushResult(params: {
  registration: ApnsRegistration;
  response: ApnsRequestResponse | ApnsRelayPushResponse;
  tokenSuffix?: string;
}): ApnsPushResult {
  const response =
    "body" in params.response
      ? {
          ok: params.response.status === 200,
          status: params.response.status,
          apnsId: params.response.apnsId,
          reason: parseReason(params.response.body),
          environment: params.registration.environment,
          tokenSuffix: params.tokenSuffix,
        }
      : params.response;
  return {
    ok: response.ok,
    status: response.status,
    apnsId: response.apnsId,
    reason: response.reason,
    tokenSuffix:
      params.tokenSuffix ??
      resolveRegistrationDebugSuffix(
        params.registration,
        "tokenSuffix" in response ? response : undefined,
      ),
    topic: params.registration.topic,
    environment: params.registration.transport === "relay" ? "production" : response.environment,
    transport: params.registration.transport,
  };
}

async function sendDirectApnsPush(params: {
  auth: ApnsAuthConfig;
  registration: DirectApnsRegistration;
  payload: object;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsPushResult> {
  const { token, topic, environment, bearerToken } = resolveDirectSendContext({
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
  return toPushResult({
    registration: params.registration,
    response,
    tokenSuffix: token.slice(-8),
  });
}

async function sendRelayApnsPush(params: {
  relayConfig: ApnsRelayConfig;
  registration: RelayApnsRegistration;
  payload: object;
  pushType: ApnsPushType;
  priority: "10" | "5";
  requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsPushResult> {
  const response = await sendApnsRelayPush({
    relayConfig: params.relayConfig,
    relayHandle: params.registration.relayHandle,
    payload: params.payload,
    pushType: params.pushType,
    priority: params.priority,
    requestSender: params.requestSender,
  });
  return toPushResult({ registration: params.registration, response });
}

function createAlertPayload(params: { nodeId: string; title: string; body: string }): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
    },
    openclaw: toPushMetadata({
      kind: "push.test",
      nodeId: params.nodeId,
    }),
  };
}

function createBackgroundPayload(params: { nodeId: string; wakeReason?: string }): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: toPushMetadata({
      kind: "node.wake",
      reason: params.wakeReason ?? "node.invoke",
      nodeId: params.nodeId,
    }),
  };
}

export async function sendApnsAlert(params: {
  auth?: ApnsAuthConfig;
  relayConfig?: ApnsRelayConfig;
  registration: ApnsRegistration;
  nodeId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
  relayRequestSender?: ApnsRelayRequestSender;
}): Promise<ApnsPushAlertResult> {
  const payload = createAlertPayload({
    nodeId: params.nodeId,
    title: params.title,
    body: params.body,
  });

  if (params.registration.transport === "relay") {
    if (!params.relayConfig) {
      throw new Error("APNs relay config required");
    }
    return await sendRelayApnsPush({
      relayConfig: params.relayConfig,
      registration: params.registration,
      payload,
      pushType: "alert",
      priority: "10",
      requestSender: params.relayRequestSender,
    });
  }
  if (!params.auth) {
    throw new Error("APNs auth required");
  }
  return await sendDirectApnsPush({
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
  auth?: ApnsAuthConfig;
  relayConfig?: ApnsRelayConfig;
  registration: ApnsRegistration;
  nodeId: string;
  wakeReason?: string;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
  relayRequestSender?: ApnsRelayRequestSender;
}): Promise<ApnsPushWakeResult> {
  const payload = createBackgroundPayload({
    nodeId: params.nodeId,
    wakeReason: params.wakeReason,
  });

  if (params.registration.transport === "relay") {
    if (!params.relayConfig) {
      throw new Error("APNs relay config required");
    }
    return await sendRelayApnsPush({
      relayConfig: params.relayConfig,
      registration: params.registration,
      payload,
      pushType: "background",
      priority: "5",
      requestSender: params.relayRequestSender,
    });
  }
  if (!params.auth) {
    throw new Error("APNs auth required");
  }
  return await sendDirectApnsPush({
    auth: params.auth,
    registration: params.registration,
    payload,
    timeoutMs: params.timeoutMs,
    requestSender: params.requestSender,
    pushType: "background",
    priority: "5",
  });
}

export { type ApnsRelayConfig, type ApnsRelayConfigResolution, resolveApnsRelayConfigFromEnv };
