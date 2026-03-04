import { normalizeTextForComparison } from "../../agents/pi-embedded-helpers/messaging-dedupe.js";
import { createDedupeCache } from "../dedupe.js";

const OUTBOUND_DEDUPE_TTL_MS = 30_000;
const OUTBOUND_DEDUPE_MAX_SIZE = 500;

const dedupeCache = createDedupeCache({
  ttlMs: OUTBOUND_DEDUPE_TTL_MS,
  maxSize: OUTBOUND_DEDUPE_MAX_SIZE,
});

export type OutboundDedupeKeyParams = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  /** Fallback replyToId from dispatch params (used when payload.replyToId is unset). */
  resolvedReplyToId?: string;
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    channelData?: Record<string, unknown>;
  };
};

/**
 * Build a deduplication key for an outbound payload.
 *
 * Returns null when the payload is empty (nothing to deduplicate).
 * The key is a JSON array of [channel, account, to, thread, normalizedText,
 * sortedMediaUrls, resolvedReplyToId, channelDataFingerprint] to avoid
 * ambiguity from delimiter collisions. `audioAsVoice` is intentionally
 * excluded so that voice/audio variants of the same content are
 * caught as duplicates (aligned with PR #30478 reasoning).
 */
export function buildOutboundDedupeKey(params: OutboundDedupeKeyParams): string | null {
  const { channel, to, accountId, threadId, resolvedReplyToId, payload } = params;
  const rawText = payload.text ?? "";
  const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const hasChannelData = Boolean(
    payload.channelData && Object.keys(payload.channelData).length > 0,
  );

  // Nothing to deduplicate for empty payloads.
  if (!rawText.trim() && mediaUrls.length === 0 && !hasChannelData) {
    return null;
  }

  const normalizedText = rawText ? normalizeTextForComparison(rawText) : "";
  const sortedMediaUrls = mediaUrls.toSorted().join(",");
  // Use the resolved replyToId (payload-level takes precedence, then dispatch-level fallback).
  const replyTo = payload.replyToId ?? resolvedReplyToId ?? "";
  const thread = threadId != null ? String(threadId) : "";
  const account = accountId ?? "";
  // Include channelData fingerprint so distinct structured payloads are not
  // collapsed into the same key (e.g. different Telegram flex layouts).
  const channelDataFp = hasChannelData
    ? JSON.stringify(payload.channelData, Object.keys(payload.channelData!).sort())
    : "";

  // Use JSON array serialization to avoid delimiter collision issues.
  return JSON.stringify([
    "out",
    channel,
    account,
    to,
    thread,
    normalizedText,
    sortedMediaUrls,
    replyTo,
    channelDataFp,
  ]);
}

/**
 * Check whether an identical outbound payload was recently delivered.
 * Peek only — does not register the key.
 */
export function isOutboundDuplicate(params: OutboundDedupeKeyParams, now?: number): boolean {
  const key = buildOutboundDedupeKey(params);
  if (!key) {
    return false;
  }
  return dedupeCache.peek(key, now);
}

/**
 * Register a successfully delivered outbound payload in the dedup cache.
 * Should be called only after successful delivery so that failed sends
 * can be retried.
 */
export function registerOutboundDelivered(params: OutboundDedupeKeyParams, now?: number): void {
  const key = buildOutboundDedupeKey(params);
  if (!key) {
    return;
  }
  // `check()` registers the key and returns false (not a duplicate) on first call.
  dedupeCache.check(key, now);
}

/** Reset the dedup cache. Intended for tests only. */
export function resetOutboundDedupe(): void {
  dedupeCache.clear();
}
