import { createDedupeCache } from "../../infra/dedupe.js";

const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;

/** Short TTL for fallback dedupe when message has no id (e.g. duplicate Baileys events). */
const FALLBACK_INBOUND_TTL_MS = 15_000;
const FALLBACK_INBOUND_MAX = 2000;

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
  maxSize: RECENT_WEB_MESSAGE_MAX,
});

const recentFallbackInbound = createDedupeCache({
  ttlMs: FALLBACK_INBOUND_TTL_MS,
  maxSize: FALLBACK_INBOUND_MAX,
});

export function resetWebInboundDedupe(): void {
  recentInboundMessages.clear();
  recentFallbackInbound.clear();
}

export function isRecentInboundMessage(key: string): boolean {
  return recentInboundMessages.check(key);
}

/**
 * Fallback dedupe for messages without a stable id (e.g. Baileys duplicate events).
 * Returns true if this key was already seen recently (caller should skip processing).
 */
export function isRecentFallbackInboundMessage(key: string): boolean {
  return recentFallbackInbound.check(key);
}

/** Build a fallback dedupe key when message has no id. Used to avoid double reply. */
export function buildFallbackInboundKey(
  accountId: string,
  remoteJid: string,
  timestampMs: number | undefined,
  from: string,
  body: string,
): string {
  const t = timestampMs != null ? Math.floor(timestampMs / 1000) : 0;
  const bodySlice = (body ?? "").trim().slice(0, 300);
  return `fb:${accountId}:${remoteJid}:${t}:${from}:${bodySlice}`;
}
