/**
 * Sliding-window rate limiter for outbound messages per (channelId, recipientId).
 *
 * Mirrors the design of src/gateway/auth-rate-limit.ts so the two stay
 * consistent and easy to reason about together.
 *
 * Design decisions:
 * - Pure in-memory Map – no external deps; fine for a single gateway process.
 * - Keyed by `${channelId}:${recipientId}` so limits are per-conversation,
 *   not global – a user talking normally is never affected by another user
 *   being rate-limited.
 * - Periodic prune to avoid unbounded Map growth over long uptimes.
 * - All config has sensible defaults so callers can use it with zero config.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboundRateLimitConfig {
  /** Max outbound messages per window per recipient. @default 20 */
  maxMessages?: number;
  /** Sliding window duration in ms. @default 60_000 (1 min) */
  windowMs?: number;
  /** Cool-down duration in ms after the limit is hit. @default 120_000 (2 min) */
  cooldownMs?: number;
  /** Background prune interval in ms; set <= 0 to disable. @default 60_000 */
  pruneIntervalMs?: number;
}

export interface OutboundRateLimitResult {
  /** Whether the message is allowed to be sent. */
  allowed: boolean;
  /** Milliseconds until send is allowed again (0 when not throttled). */
  retryAfterMs: number;
}

export interface OutboundRateLimiter {
  /**
   * Check whether a message may be sent to `recipientId` on `channelId`.
   * Call this BEFORE sending.
   */
  check(channelId: string, recipientId: string): OutboundRateLimitResult;
  /**
   * Record that a message was sent to `recipientId` on `channelId`.
   * Call this AFTER a successful send (only when check() returned allowed=true).
   */
  record(channelId: string, recipientId: string): void;
  /** Return the number of currently tracked (channel, recipient) pairs. */
  size(): number;
  /** Remove expired entries and free memory. */
  prune(): void;
  /** Stop background timers and clear state. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_COOLDOWN_MS = 120_000; // 2 minutes
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Entry {
  /** Epoch-ms timestamps of recent outbound messages inside the window. */
  timestamps: number[];
  /** If set, sending is blocked until this epoch-ms instant. */
  coolUntil?: number;
}

export function createOutboundRateLimiter(config?: OutboundRateLimitConfig): OutboundRateLimiter {
  const maxMessages = config?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const pruneIntervalMs = config?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;

  const entries = new Map<string, Entry>();

  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  if (pruneTimer && "unref" in pruneTimer) {
    pruneTimer.unref();
  }

  function entryKey(channelId: string, recipientId: string): string {
    return `${channelId}:${recipientId}`;
  }

  function slideWindow(entry: Entry, now: number): void {
    entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);
  }

  function check(channelId: string, recipientId: string): OutboundRateLimitResult {
    const key = entryKey(channelId, recipientId);
    const now = Date.now();
    const entry = entries.get(key);

    if (!entry) {
      return { allowed: true, retryAfterMs: 0 };
    }

    // Still in cool-down?
    if (entry.coolUntil && now < entry.coolUntil) {
      return { allowed: false, retryAfterMs: entry.coolUntil - now };
    }

    // Cool-down expired — reset.
    if (entry.coolUntil && now >= entry.coolUntil) {
      entry.coolUntil = undefined;
      entry.timestamps = [];
    }

    slideWindow(entry, now);

    if (entry.timestamps.length >= maxMessages) {
      entry.coolUntil = now + cooldownMs;
      return { allowed: false, retryAfterMs: cooldownMs };
    }

    return { allowed: true, retryAfterMs: 0 };
  }

  function record(channelId: string, recipientId: string): void {
    const key = entryKey(channelId, recipientId);
    const now = Date.now();

    let entry = entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      entries.set(key, entry);
    }

    // Don't record while in cool-down — the send should have been blocked.
    if (entry.coolUntil && now < entry.coolUntil) {
      return;
    }

    slideWindow(entry, now);
    entry.timestamps.push(now);
  }

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.coolUntil && now < entry.coolUntil) {
        continue; // Keep locked entries.
      }
      slideWindow(entry, now);
      if (entry.timestamps.length === 0 && !entry.coolUntil) {
        entries.delete(key);
      }
    }
  }

  function size(): number {
    return entries.size;
  }

  function dispose(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    entries.clear();
  }

  return { check, record, prune, size, dispose };
}
