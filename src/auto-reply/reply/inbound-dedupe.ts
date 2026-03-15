import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { createDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");

const inboundDedupeCache = resolveGlobalSingleton<DedupeCache>(INBOUND_DEDUPE_CACHE_KEY, () =>
  createDedupeCache({
    ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
    maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
  }),
);

const normalizeProvider = (value?: string | null) => value?.trim().toLowerCase() || "";

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScopeFromKey(sessionKey?: string | null): string {
  const trimmed = sessionKey?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  return `agent:${parsed.agentId}`;
}

export function buildInboundDedupeKeyFromParts(params: {
  provider?: string | null;
  messageId?: string | null;
  peerId?: string | null;
  sessionKey?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
}): string | null {
  const provider = normalizeProvider(params.provider);
  const messageId = params.messageId?.trim();
  if (!provider || !messageId) {
    return null;
  }
  const peerId = params.peerId?.trim();
  if (!peerId) {
    return null;
  }
  const sessionKey = resolveInboundDedupeSessionScopeFromKey(params.sessionKey);
  const accountId = params.accountId?.trim() ?? "";
  const threadId =
    params.threadId !== undefined && params.threadId !== null ? String(params.threadId) : "";
  return [provider, accountId, sessionKey, peerId, threadId, messageId].filter(Boolean).join("|");
}

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  return buildInboundDedupeKeyFromParts({
    provider: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
    messageId: ctx.MessageSid,
    peerId: resolveInboundPeerId(ctx),
    sessionKey:
      (ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey : undefined) ?? ctx.SessionKey,
    accountId: ctx.AccountId,
    threadId: ctx.MessageThreadId,
  });
}

export function shouldSkipDuplicateInbound(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number },
): boolean {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return false;
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  const skipped = cache.check(key, opts?.now);
  if (skipped && shouldLogVerbose()) {
    logVerbose(`inbound dedupe: skipped ${key}`);
  }
  return skipped;
}

export function markInboundMessageAsSeen(params: {
  provider?: string | null;
  messageId?: string | null;
  peerId?: string | null;
  sessionKey?: string | null;
  accountId?: string | null;
  threadId?: string | number | null;
  cache?: DedupeCache;
  now?: number;
}): boolean {
  const key = buildInboundDedupeKeyFromParts(params);
  if (!key) {
    return false;
  }
  const cache = params.cache ?? inboundDedupeCache;
  cache.mark(key, params.now);
  if (shouldLogVerbose()) {
    logVerbose(`inbound dedupe: marked ${key}`);
  }
  return true;
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
}
