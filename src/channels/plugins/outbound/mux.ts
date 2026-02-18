import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PollInput } from "../../../polls.js";
import { loadOrCreateDeviceIdentity } from "../../../infra/device-identity.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";

type SupportedMuxChannel = "whatsapp" | "telegram" | "discord";

type ResolvedChannelMuxConfig = {
  enabled: boolean;
  timeoutMs: number;
};

type MuxSendRequest = {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
  sessionKey?: string | null;
  to?: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
  threadId?: string | number | null;
  channelData?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  poll?: PollInput;
};

type MuxSendResponse = {
  messageId: string;
  chatId?: string;
  channelId?: string;
  toJid?: string;
  conversationId?: string;
  pollId?: string;
};

type MuxSendResponseBody = {
  messageId?: unknown;
  chatId?: unknown;
  channelId?: unknown;
  toJid?: unknown;
  conversationId?: unknown;
  pollId?: unknown;
  error?: unknown;
};

type MuxRegisterResponseBody = {
  ok: boolean;
  runtimeToken?: string;
  expiresAtMs?: number;
  error?: string;
};

type ResolvedMuxConfig = {
  baseUrl: string;
  registerKey: string;
  openclawId: string;
  inboundUrl: string;
  timeoutMs: number;
  sessionKey: string;
};

type RuntimeTokenCacheEntry = {
  token: string;
  expiresAtMs: number;
  registeredAtMs: number;
};

class MuxRegisterError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "MuxRegisterError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RUNTIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_RUNTIME_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

const runtimeTokenCache = new Map<string, RuntimeTokenCacheEntry>();
const runtimeTokenRefreshInFlight = new Map<string, Promise<RuntimeTokenCacheEntry>>();
let cachedDefaultOpenClawId: string | null = null;

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeChannelMuxConfig(
  raw: { enabled?: boolean; timeoutMs?: number } | undefined,
): ResolvedChannelMuxConfig {
  return {
    enabled: raw?.enabled === true,
    timeoutMs:
      typeof raw?.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
        ? Math.trunc(raw.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
  };
}

function resolveChannelMuxConfig(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
}): ResolvedChannelMuxConfig {
  const { cfg, channel, accountId } = params;
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  if (channel === "telegram") {
    const channelCfg = cfg.channels?.telegram;
    const accountCfg = channelCfg?.accounts?.[resolvedAccountId];
    return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
  }
  if (channel === "discord") {
    const channelCfg = cfg.channels?.discord;
    const accountCfg = channelCfg?.accounts?.[resolvedAccountId];
    return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
  }
  const channelCfg = cfg.channels?.whatsapp;
  const accountCfg = channelCfg?.accounts?.[resolvedAccountId];
  return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
}

function resolveDefaultOpenClawId(): string {
  if (!cachedDefaultOpenClawId) {
    cachedDefaultOpenClawId = loadOrCreateDeviceIdentity().deviceId;
  }
  return cachedDefaultOpenClawId;
}

function resolveGatewayInboundUrl(cfg: OpenClawConfig): string {
  const configured = readString(cfg.gateway?.http?.endpoints?.mux?.inboundUrl);
  if (configured) {
    return configured;
  }
  throw new Error(
    "gateway.http.endpoints.mux.inboundUrl is required (must be reachable by mux-server)",
  );
}

export function resolveMuxOpenClawId(cfg: OpenClawConfig): string {
  void cfg;
  return resolveDefaultOpenClawId();
}

export function isMuxEnabled(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
}): boolean {
  return resolveChannelMuxConfig(params).enabled;
}

function requireMuxConfig(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
  sessionKey?: string | null;
}): ResolvedMuxConfig {
  const resolved = resolveChannelMuxConfig(params);
  const gatewayMuxBaseUrl = normalizeBaseUrl(params.cfg.gateway?.http?.endpoints?.mux?.baseUrl);
  const registerKey = readString(params.cfg.gateway?.http?.endpoints?.mux?.registerKey);
  if (!resolved.enabled) {
    throw new Error(`mux is not enabled for channel ${params.channel}`);
  }
  if (!gatewayMuxBaseUrl) {
    throw new Error(
      `gateway.http.endpoints.mux.baseUrl is required when channels.${params.channel}.mux.enabled=true`,
    );
  }
  if (!registerKey) {
    throw new Error(
      `gateway.http.endpoints.mux.registerKey is required when channels.${params.channel}.mux.enabled=true`,
    );
  }

  const sessionKey = readString(params.sessionKey);
  if (!sessionKey) {
    throw new Error(`mux outbound for ${params.channel} requires a sessionKey`);
  }

  const openclawId = resolveDefaultOpenClawId();
  const inboundUrl = resolveGatewayInboundUrl(params.cfg);

  return {
    baseUrl: gatewayMuxBaseUrl,
    registerKey,
    openclawId,
    inboundUrl,
    timeoutMs: resolved.timeoutMs,
    sessionKey,
  };
}

function mapMuxSendResponse(
  channel: SupportedMuxChannel,
  payload: MuxSendResponseBody,
): MuxSendResponse {
  const messageId = readString(payload.messageId);
  if (!messageId) {
    throw new Error(`mux outbound success missing messageId for channel ${channel}`);
  }

  return {
    messageId,
    chatId: readString(payload.chatId),
    channelId: readString(payload.channelId),
    toJid: channel === "whatsapp" ? readString(payload.toJid) : undefined,
    conversationId: readString(payload.conversationId),
    pollId: readString(payload.pollId),
  };
}

function runtimeTokenCacheKey(params: { baseUrl: string; openclawId: string; inboundUrl: string }) {
  return `${params.baseUrl}:${params.openclawId}:${params.inboundUrl}`;
}

function clearRuntimeTokenCache(params: {
  baseUrl: string;
  openclawId: string;
  inboundUrl: string;
}) {
  const key = runtimeTokenCacheKey(params);
  runtimeTokenCache.delete(key);
  runtimeTokenRefreshInFlight.delete(key);
}

function shouldRefreshRuntimeToken(entry: RuntimeTokenCacheEntry, nowMs: number): boolean {
  const ttlMs = Math.max(1, entry.expiresAtMs - entry.registeredAtMs);
  const refreshWindowMs = Math.max(MIN_RUNTIME_REFRESH_WINDOW_MS, Math.trunc(ttlMs * 0.1));
  return entry.expiresAtMs <= nowMs + refreshWindowMs;
}

async function registerRuntimeToken(params: {
  baseUrl: string;
  timeoutMs: number;
  registerKey: string;
  openclawId: string;
  inboundUrl: string;
}): Promise<RuntimeTokenCacheEntry> {
  const response = await fetch(`${params.baseUrl}/v1/instances/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.registerKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      openclawId: params.openclawId,
      inboundUrl: params.inboundUrl,
      inboundTimeoutMs: params.timeoutMs,
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  const parsedBody = (await response.json()) as MuxRegisterResponseBody;
  if (!response.ok) {
    throw new MuxRegisterError(
      response.status,
      `mux register failed (${response.status}): ${parsedBody.error ?? "request failed"}`,
    );
  }
  const runtimeToken = String(parsedBody.runtimeToken);

  const nowMs = Date.now();
  const expiresAtMs = Math.max(
    nowMs + 60_000,
    Math.trunc(parsedBody.expiresAtMs ?? nowMs + DEFAULT_RUNTIME_TOKEN_TTL_MS),
  );

  return {
    token: runtimeToken,
    expiresAtMs,
    registeredAtMs: nowMs,
  };
}

async function resolveRuntimeToken(params: {
  resolved: ResolvedMuxConfig;
  forceRefresh?: boolean;
}): Promise<string> {
  const cacheKey = runtimeTokenCacheKey(params.resolved);
  const nowMs = Date.now();

  if (!params.forceRefresh) {
    const cached = runtimeTokenCache.get(cacheKey);
    if (cached && !shouldRefreshRuntimeToken(cached, nowMs)) {
      return cached.token;
    }
  }

  let inFlight = runtimeTokenRefreshInFlight.get(cacheKey);
  if (!inFlight) {
    inFlight = registerRuntimeToken({
      baseUrl: params.resolved.baseUrl,
      timeoutMs: params.resolved.timeoutMs,
      registerKey: params.resolved.registerKey,
      openclawId: params.resolved.openclawId,
      inboundUrl: params.resolved.inboundUrl,
    })
      .then((entry) => {
        runtimeTokenCache.set(cacheKey, entry);
        return entry;
      })
      .finally(() => {
        runtimeTokenRefreshInFlight.delete(cacheKey);
      });
    runtimeTokenRefreshInFlight.set(cacheKey, inFlight);
  }

  const entry = await inFlight;
  return entry.token;
}

export function startMuxRuntimeRegistrationLoop(params: {
  cfg: OpenClawConfig;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}): () => void {
  const endpointCfg = params.cfg.gateway?.http?.endpoints?.mux;
  if (endpointCfg?.enabled !== true) {
    return () => {};
  }

  const baseUrl = normalizeBaseUrl(endpointCfg.baseUrl);
  const registerKey = readString(endpointCfg.registerKey);
  const inboundUrl = readString(endpointCfg.inboundUrl);
  if (!baseUrl || !registerKey || !inboundUrl) {
    params.log?.warn(
      "mux: gateway.http.endpoints.mux.enabled=true but baseUrl/registerKey/inboundUrl is missing; skipping registration",
    );
    return () => {};
  }

  const openclawId = resolveDefaultOpenClawId();
  const cacheKey = runtimeTokenCacheKey({ baseUrl, openclawId, inboundUrl });

  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const scheduleRetry = (delayMs: number) => {
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runOnce();
    }, delayMs);
  };

  const runOnce = async () => {
    if (stopped) {
      return;
    }
    attempt += 1;
    try {
      let inFlight = runtimeTokenRefreshInFlight.get(cacheKey);
      if (!inFlight) {
        inFlight = registerRuntimeToken({
          baseUrl,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          registerKey,
          openclawId,
          inboundUrl,
        })
          .then((entry) => {
            runtimeTokenCache.set(cacheKey, entry);
            return entry;
          })
          .finally(() => {
            runtimeTokenRefreshInFlight.delete(cacheKey);
          });
        runtimeTokenRefreshInFlight.set(cacheKey, inFlight);
      }
      await inFlight;
      params.log?.info(`mux: registered instance ${openclawId}`);
    } catch (error) {
      if (stopped) {
        return;
      }
      const statusCode = error instanceof MuxRegisterError ? error.statusCode : null;
      const text = error instanceof Error ? error.message : String(error);
      params.log?.warn(`mux: register failed${statusCode ? ` (${statusCode})` : ""}: ${text}`);

      // Misconfig (or id conflict) won't self-heal without a restart/config fix.
      if (statusCode === 400 || statusCode === 401 || statusCode === 404 || statusCode === 409) {
        return;
      }

      const retryDelayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      scheduleRetry(retryDelayMs);
    }
  };

  // Fire-and-forget on gateway boot.
  void runOnce();

  return () => {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}

async function resolveRuntimeHeaders(params: {
  resolved: ResolvedMuxConfig;
  forceRefresh?: boolean;
}): Promise<Record<string, string>> {
  const token = await resolveRuntimeToken({
    resolved: params.resolved,
    forceRefresh: params.forceRefresh,
  });

  return {
    Authorization: `Bearer ${token}`,
    "X-OpenClaw-Id": params.resolved.openclawId,
  };
}

async function postMuxJson(params: {
  resolved: ResolvedMuxConfig;
  path: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
}): Promise<Response> {
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const headers = await resolveRuntimeHeaders({
      resolved: params.resolved,
      forceRefresh: attempt > 0,
    });

    const response = await fetch(`${params.resolved.baseUrl}${params.path}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        ...(params.idempotencyKey ? { "Idempotency-Key": params.idempotencyKey } : {}),
      },
      body: JSON.stringify(params.payload),
      signal: AbortSignal.timeout(params.resolved.timeoutMs),
    });

    if (response.status === 401 && attempt === 0) {
      clearRuntimeTokenCache({
        baseUrl: params.resolved.baseUrl,
        openclawId: params.resolved.openclawId,
        inboundUrl: params.resolved.inboundUrl,
      });
      continue;
    }

    return response;
  }

  throw new Error("mux request failed after auth retry");
}

export async function fetchMuxFileStream(params: {
  cfg: OpenClawConfig;
  url: string;
  timeoutMs?: number;
}): Promise<Response> {
  const endpointCfg = params.cfg.gateway?.http?.endpoints?.mux;
  const baseUrl = normalizeBaseUrl(endpointCfg?.baseUrl);
  const registerKey = readString(endpointCfg?.registerKey);
  if (!baseUrl || !registerKey) {
    throw new Error("mux baseUrl/registerKey not configured");
  }
  const openclawId = resolveDefaultOpenClawId();
  const inboundUrl = resolveGatewayInboundUrl(params.cfg);

  const resolved: ResolvedMuxConfig = {
    baseUrl,
    registerKey,
    openclawId,
    inboundUrl,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    sessionKey: "",
  };

  const headers = await resolveRuntimeHeaders({ resolved });
  const response = await fetch(params.url, {
    headers,
    signal: AbortSignal.timeout(resolved.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`mux file fetch failed (${response.status})`);
  }
  return response;
}

export function __resetMuxRuntimeAuthCacheForTest() {
  runtimeTokenCache.clear();
  runtimeTokenRefreshInFlight.clear();
  cachedDefaultOpenClawId = null;
}

export async function sendViaMux(params: MuxSendRequest): Promise<MuxSendResponse> {
  const resolved = requireMuxConfig({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
  });

  const requestId = randomUUID();
  const payload = {
    requestId,
    channel: params.channel,
    sessionKey: resolved.sessionKey,
    accountId: params.accountId,
    to: params.to,
    text: params.text ?? "",
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    replyToId: params.replyToId ?? undefined,
    threadId: params.threadId ?? undefined,
    channelData: params.channelData,
    raw: params.raw,
    poll: params.poll,
    openclawId: resolved.openclawId,
  };

  const response = await postMuxJson({
    resolved,
    path: "/v1/mux/outbound/send",
    idempotencyKey: requestId,
    payload,
  });

  const parsedBody = (await response.json()) as MuxSendResponseBody;
  if (!response.ok) {
    throw new Error(
      `mux outbound failed (${response.status}): ${readString(parsedBody.error) ?? "request failed"}`,
    );
  }

  return mapMuxSendResponse(params.channel, parsedBody);
}

export async function sendTypingViaMux(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
  sessionKey?: string | null;
}): Promise<void> {
  const resolved = requireMuxConfig({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
  });

  const payload = {
    requestId: randomUUID(),
    op: "action",
    action: "typing",
    channel: params.channel,
    sessionKey: resolved.sessionKey,
    accountId: params.accountId,
    openclawId: resolved.openclawId,
  };

  const response = await postMuxJson({
    resolved,
    path: "/v1/mux/outbound/send",
    idempotencyKey: payload.requestId,
    payload,
  });

  if (!response.ok) {
    const parsedBody = (await response.json()) as { error?: unknown };
    throw new Error(
      `mux action failed (${response.status}): ${readString(parsedBody.error) ?? "request failed"}`,
    );
  }
}
