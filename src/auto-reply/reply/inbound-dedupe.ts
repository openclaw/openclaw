import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { resolveGlobalDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");

const inboundDedupeCache: DedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});

const normalizeProvider = (value?: string | null) =>
  normalizeOptionalString(value)?.toLowerCase() || "";

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScope(ctx: MsgContext): string {
  const sessionKey =
    (ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined) ||
    normalizeOptionalString(ctx.SessionKey) ||
    "";
  if (!sessionKey) {
    return "";
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return sessionKey;
  }
  // The same physical inbound message should never run twice for the same
  // agent, even if a routing bug presents it under both main and direct keys.
  return `agent:${parsed.agentId}`;
}

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider = normalizeProvider(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const messageId = normalizeOptionalString(ctx.MessageSid);
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionScope = resolveInboundDedupeSessionScope(ctx);
  const accountId = normalizeOptionalString(ctx.AccountId) ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  return [provider, accountId, sessionScope, peerId, threadId, messageId].filter(Boolean).join("|");
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

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
}
