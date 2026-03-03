import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { createDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { normalizeHeartbeatPollForDedupe } from "../heartbeat.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;
const DEFAULT_HEARTBEAT_POLL_DEDUPE_TTL_MS = 60 * 60_000;
const DEFAULT_HEARTBEAT_POLL_DEDUPE_MAX = 2000;

const inboundDedupeCache = createDedupeCache({
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const heartbeatPollDedupeCache = createDedupeCache({
  ttlMs: DEFAULT_HEARTBEAT_POLL_DEDUPE_TTL_MS,
  maxSize: DEFAULT_HEARTBEAT_POLL_DEDUPE_MAX,
});

const normalizeProvider = (value?: string | null) => value?.trim().toLowerCase() || "";

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundTextBody(ctx: MsgContext): string {
  const candidates = [ctx.BodyForCommands, ctx.CommandBody, ctx.RawBody, ctx.Body];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    return trimmed;
  }
  return "";
}

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider = normalizeProvider(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const messageId = ctx.MessageSid?.trim();
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionKey = ctx.SessionKey?.trim() ?? "";
  const accountId = ctx.AccountId?.trim() ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  return [provider, accountId, sessionKey, peerId, threadId, messageId].filter(Boolean).join("|");
}

export function shouldSkipDuplicateInbound(
  ctx: MsgContext,
  opts?: {
    cache?: DedupeCache;
    heartbeatCache?: DedupeCache;
    config?: OpenClawConfig;
    now?: number;
  },
): boolean {
  const sidKey = buildInboundDedupeKey(ctx);
  const cache = opts?.cache ?? inboundDedupeCache;
  if (sidKey) {
    const skipped = cache.check(sidKey, opts?.now);
    if (skipped && shouldLogVerbose()) {
      logVerbose(`inbound dedupe: skipped ${sidKey}`);
    }
    if (skipped) {
      return true;
    }
  }

  const provider = normalizeProvider(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const peerId = resolveInboundPeerId(ctx);
  if (!provider || !peerId) {
    return false;
  }
  const sessionKey = ctx.SessionKey?.trim() ?? "";
  const accountId = ctx.AccountId?.trim() ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  const body = resolveInboundTextBody(ctx);
  const dedupeBody = normalizeHeartbeatPollForDedupe(body, {
    prompt: opts?.config?.agents?.defaults?.heartbeat?.prompt,
  });
  if (!dedupeBody) {
    return false;
  }

  const heartbeatKey = [provider, accountId, sessionKey, peerId, threadId, dedupeBody]
    .filter(Boolean)
    .join("|");
  const heartbeatCache = opts?.heartbeatCache ?? heartbeatPollDedupeCache;
  const skippedHeartbeat = heartbeatCache.check(heartbeatKey, opts?.now);
  if (skippedHeartbeat && shouldLogVerbose()) {
    logVerbose(`inbound dedupe: skipped heartbeat poll ${heartbeatKey}`);
  }
  return skippedHeartbeat;
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  heartbeatPollDedupeCache.clear();
}
