import { createHash } from "node:crypto"; import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { resolveGlobalDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeInflight");

const inboundDedupeCache: DedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Set<string>(),
);

export type InboundDedupeClaimResult =
  | { status: "invalid" }
  | { status: "duplicate"; key: string }
  | { status: "inflight"; key: string }
  | { status: "claimed"; key: string };

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
  const provider =
    normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface) || "";
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
  const routeKey = channelRouteDedupeKey({
    channel: provider,
    to: peerId,
    accountId,
    threadId: ctx.MessageThreadId,
  });

  // Primary: stable MessageSid from channel — safe dedupe.
  if (messageId) {
    return JSON.stringify([sessionScope, routeKey, messageId]);
  }

  // Fallback: some channel retries generate new MessageSid per attempt, bypassing
  // the primary dedupe. Without a stable messageId, we use a content hash (Body|Timestamp)
  // to catch duplicate retries.
  //
  // Note: This is a heuristic. If the channel emits coarse or varying timestamps
  // across retries, the hash may not match and duplicates can slip through.
  // Also, distinct messages with same body from same sender will suppress each other
  // (unlikely for user chat, more relevant for system events).
  const contentHash = createHash("sha256")
    .update(`${ctx.Body ?? ""}|${ctx.Timestamp ?? ""}|${ctx.From ?? ""}`, "utf8")
    .digest("hex")
    .substring(0, 16);
  return JSON.stringify([sessionScope, routeKey, `content:${contentHash}`]);
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

export function claimInboundDedupe(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Set<string> },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  if (cache.peek(key, opts?.now)) {
    return { status: "duplicate", key };
  }
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  if (inFlight.has(key)) {
    return { status: "inflight", key };
  }
  inFlight.add(key);
  return { status: "claimed", key };
}

export function commitInboundDedupe(
  key: string,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Set<string> },
): void {
  const cache = opts?.cache ?? inboundDedupeCache;
  cache.check(key, opts?.now);
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

export function releaseInboundDedupe(key: string, opts?: { inFlight?: Set<string> }): void {
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  inboundDedupeInFlight.clear();
}
