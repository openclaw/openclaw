import type { FallbackAttempt } from "../../agents/model-fallback.js";

/** Maximum number of sessions tracked before evicting the oldest entries. */
const MAX_TRACKED_SESSIONS = 1000;

/** Time-to-live for each entry (1 hour). */
const ENTRY_TTL_MS = 60 * 60 * 1000;

interface TrackedFallback {
  model: string;
  ts: number;
}

/**
 * In-memory tracker for fallback model notifications.
 *
 * Ensures the user is notified only ONCE per failover event —
 * i.e., when the fallback model changes or the primary recovers
 * and then fails again.
 *
 * Entries are capped at {@link MAX_TRACKED_SESSIONS} and expire
 * after {@link ENTRY_TTL_MS} to prevent unbounded memory growth.
 */
const lastNotifiedFallback = new Map<string, TrackedFallback>();

/** Evict entries older than {@link ENTRY_TTL_MS}. */
function evictStale(now: number): void {
  for (const [key, entry] of lastNotifiedFallback) {
    if (now - entry.ts > ENTRY_TTL_MS) {
      lastNotifiedFallback.delete(key);
    } else {
      // Map iterates in insertion order; once we hit a fresh entry the rest are newer.
      break;
    }
  }
}

/** Evict oldest entries until the map is within the size cap. */
function evictOldest(): void {
  while (lastNotifiedFallback.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastNotifiedFallback.keys().next().value;
    if (oldest !== undefined) {
      lastNotifiedFallback.delete(oldest);
    } else {
      break;
    }
  }
}

/**
 * Determine whether a fallback notification should be shown to the user.
 *
 * Returns a notification message when:
 * 1. The primary model failed and a different fallback model was used
 * 2. We haven't already notified about this specific fallback for this session
 *
 * Clears the tracker when the primary model succeeds (no attempts).
 */
export function checkFallbackNotification(params: {
  sessionKey: string | undefined;
  originalProvider: string;
  originalModel: string;
  usedProvider: string;
  usedModel: string;
  attempts: FallbackAttempt[];
}): string | undefined {
  const { sessionKey, originalProvider, originalModel, usedProvider, usedModel, attempts } = params;

  const now = Date.now();
  evictStale(now);

  // No failed attempts — primary model succeeded
  if (attempts.length === 0) {
    if (sessionKey) {
      lastNotifiedFallback.delete(sessionKey);
    }
    return undefined;
  }

  // Fallback was used — check if it's actually a different model
  const usedKey = `${usedProvider}/${usedModel}`;
  const primaryKey = `${originalProvider}/${originalModel}`;

  if (usedKey === primaryKey) {
    return undefined;
  }

  // Already notified about this exact fallback for this session
  if (sessionKey) {
    const existing = lastNotifiedFallback.get(sessionKey);
    if (existing && existing.model === usedKey) {
      return undefined;
    }
  }

  // Record notification
  if (sessionKey) {
    // Delete first so re-insertion moves the key to the end (freshest).
    lastNotifiedFallback.delete(sessionKey);
    lastNotifiedFallback.set(sessionKey, { model: usedKey, ts: now });
    evictOldest();
  }

  // Build a concise reason from the first failed attempt
  const primaryAttempt = attempts[0];
  const reason = primaryAttempt?.reason ? ` (${primaryAttempt.reason})` : "";

  return `⚡ Using fallback model \`${usedProvider}/${usedModel}\` — primary \`${primaryKey}\` is unavailable${reason}`;
}
