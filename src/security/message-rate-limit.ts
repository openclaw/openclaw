/**
 * Per-sender sliding-window rate limiter for inbound messages.
 *
 * Tracks message timestamps by composite key (channel:account:sender).
 * Enforces per-minute, per-hour, and burst limits with configurable cooldown.
 *
 * Follows the same in-memory Map + periodic prune pattern as
 * {@link ../gateway/auth-rate-limit.ts}.
 */

import type { CostBudgetStatus } from "./cost-budget.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThrottleResponseMode = "silent" | "notify-once" | "notify-always";

export type MessageRateLimitConfig = {
  /** Master switch. @default true */
  enabled?: boolean;
  /** Max messages in a 60 s sliding window. @default 20 */
  maxMessagesPerMinute?: number;
  /** Max messages in a 3600 s sliding window. @default 200 */
  maxMessagesPerHour?: number;
  /** Max messages in a 10 s burst window. @default 5 */
  burstLimit?: number;
  /** Cooldown duration (ms) after a burst is detected. @default 60_000 */
  cooldownMs?: number;
  /** Sender IDs completely exempt from rate limiting. */
  exemptSenders?: string[];
  /** Channels completely exempt from rate limiting (e.g. "webchat"). */
  exemptChannels?: string[];
  /** Background prune interval in ms; <=0 disables auto-prune. @default 60_000 */
  pruneIntervalMs?: number;
  /** Per-channel limit overrides. */
  perChannel?: Record<
    string,
    {
      maxMessagesPerMinute?: number;
      maxMessagesPerHour?: number;
      burstLimit?: number;
    }
  >;
};

export type MessageRateLimitResult = {
  allowed: boolean;
  /** Messages remaining in the per-minute window. */
  remaining: number;
  /** When throttled, milliseconds until the sender may retry. */
  retryAfterMs?: number;
  /** Reason the message was throttled. */
  reason?: "burst" | "per-minute" | "per-hour" | "cooldown";
  /** Attached cost budget status when cost budgets are enabled. */
  budget?: CostBudgetStatus;
};

export type SenderRateLimitStats = {
  messagesLastMinute: number;
  messagesLastHour: number;
  burstCount: number;
  cooldownUntil?: number;
  lastMessageAt?: number;
};

export type MessageRateLimiter = {
  /** Check whether the sender key is currently allowed to send. */
  check(key: string): MessageRateLimitResult;
  /** Record a successfully dispatched message for the sender key. */
  record(key: string): void;
  /** Reset rate-limit state for a single sender key. */
  reset(key: string): void;
  /** Clear all rate-limit state. */
  resetAll(): void;
  /** Number of tracked sender keys. */
  size(): number;
  /** Remove expired entries to reclaim memory. */
  prune(): void;
  /** Dispose the limiter and cancel periodic timers. */
  dispose(): void;
  /** Retrieve stats for a single sender key (null if not tracked). */
  getStats(key: string): SenderRateLimitStats | null;
};

// ---------------------------------------------------------------------------
// Rate-limit identity helpers
// ---------------------------------------------------------------------------

export type RateLimitIdentity = {
  channel: string;
  accountId: string;
  senderId: string;
  sessionKey?: string;
};

export function buildRateLimitKey(identity: RateLimitIdentity): string {
  const base = `${identity.channel}:${identity.accountId}:${identity.senderId}`;
  return identity.sessionKey ? `${base}:${identity.sessionKey}` : base;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PER_MINUTE = 20;
const DEFAULT_MAX_PER_HOUR = 200;
const DEFAULT_BURST_LIMIT = 5;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

const BURST_WINDOW_MS = 10_000;
const MINUTE_WINDOW_MS = 60_000;
const HOUR_WINDOW_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Internal entry
// ---------------------------------------------------------------------------

type SenderEntry = {
  /** Timestamps (epoch ms) of recorded messages. */
  timestamps: number[];
  /** If set, sender is in cooldown until this epoch-ms. */
  cooldownUntil?: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createMessageRateLimiter(config?: MessageRateLimitConfig): MessageRateLimiter {
  const enabled = config?.enabled !== false;
  const maxPerMinute = config?.maxMessagesPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const maxPerHour = config?.maxMessagesPerHour ?? DEFAULT_MAX_PER_HOUR;
  const burstLimit = config?.burstLimit ?? DEFAULT_BURST_LIMIT;
  const cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const pruneIntervalMs = config?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const exemptSenders = new Set(config?.exemptSenders ?? []);
  const exemptChannels = new Set(config?.exemptChannels ?? []);
  const perChannel = config?.perChannel ?? {};

  const entries = new Map<string, SenderEntry>();

  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  if (pruneTimer) {
    pruneTimer.unref();
  }

  function resolveChannelFromKey(key: string): string | undefined {
    const idx = key.indexOf(":");
    return idx >= 0 ? key.slice(0, idx) : undefined;
  }

  function resolveLimits(key: string) {
    const channel = resolveChannelFromKey(key);
    const override = channel ? perChannel[channel] : undefined;
    return {
      perMinute: override?.maxMessagesPerMinute ?? maxPerMinute,
      perHour: override?.maxMessagesPerHour ?? maxPerHour,
      burst: override?.burstLimit ?? burstLimit,
    };
  }

  function isExempt(key: string): boolean {
    if (!enabled) {
      return true;
    }
    const parts = key.split(":");
    const channel = parts[0];
    const senderId = parts[2];
    if (channel && exemptChannels.has(channel)) {
      return true;
    }
    if (senderId && exemptSenders.has(senderId)) {
      return true;
    }
    if (exemptSenders.has(key)) {
      return true;
    }
    return false;
  }

  function slideWindow(entry: SenderEntry, cutoff: number): void {
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
  }

  function countInWindow(entry: SenderEntry, now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    let count = 0;
    for (const ts of entry.timestamps) {
      if (ts > cutoff) {
        count += 1;
      }
    }
    return count;
  }

  function check(key: string): MessageRateLimitResult {
    if (isExempt(key)) {
      return { allowed: true, remaining: maxPerMinute };
    }

    const now = Date.now();
    const entry = entries.get(key);
    const limits = resolveLimits(key);

    if (!entry) {
      return { allowed: true, remaining: limits.perMinute };
    }

    // Cooldown active?
    if (entry.cooldownUntil && now < entry.cooldownUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.cooldownUntil - now,
        reason: "cooldown",
      };
    }

    // Cooldown expired — clear it.
    if (entry.cooldownUntil && now >= entry.cooldownUntil) {
      entry.cooldownUntil = undefined;
    }

    const burstCount = countInWindow(entry, now, BURST_WINDOW_MS);
    if (burstCount >= limits.burst) {
      entry.cooldownUntil = now + cooldownMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: cooldownMs,
        reason: "burst",
      };
    }

    const minuteCount = countInWindow(entry, now, MINUTE_WINDOW_MS);
    if (minuteCount >= limits.perMinute) {
      const oldest = entry.timestamps.find((ts) => ts > now - MINUTE_WINDOW_MS);
      const retryAfterMs = oldest ? oldest - (now - MINUTE_WINDOW_MS) : MINUTE_WINDOW_MS;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        reason: "per-minute",
      };
    }

    const hourCount = countInWindow(entry, now, HOUR_WINDOW_MS);
    if (hourCount >= limits.perHour) {
      const oldest = entry.timestamps.find((ts) => ts > now - HOUR_WINDOW_MS);
      const retryAfterMs = oldest ? oldest - (now - HOUR_WINDOW_MS) : HOUR_WINDOW_MS;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        reason: "per-hour",
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limits.perMinute - minuteCount),
    };
  }

  function record(key: string): void {
    if (isExempt(key)) {
      return;
    }

    const now = Date.now();
    let entry = entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      entries.set(key, entry);
    }
    entry.timestamps.push(now);
  }

  function reset(key: string): void {
    entries.delete(key);
  }

  function resetAll(): void {
    entries.clear();
  }

  function size(): number {
    return entries.size;
  }

  function prune(): void {
    const now = Date.now();
    const hourCutoff = now - HOUR_WINDOW_MS;
    for (const [key, entry] of entries) {
      if (entry.cooldownUntil && now < entry.cooldownUntil) {
        continue;
      }
      entry.cooldownUntil = undefined;
      slideWindow(entry, hourCutoff);
      if (entry.timestamps.length === 0) {
        entries.delete(key);
      }
    }
  }

  function dispose(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    entries.clear();
  }

  function getStats(key: string): SenderRateLimitStats | null {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    const now = Date.now();
    return {
      messagesLastMinute: countInWindow(entry, now, MINUTE_WINDOW_MS),
      messagesLastHour: countInWindow(entry, now, HOUR_WINDOW_MS),
      burstCount: countInWindow(entry, now, BURST_WINDOW_MS),
      cooldownUntil: entry.cooldownUntil,
      lastMessageAt: entry.timestamps.at(-1),
    };
  }

  return { check, record, reset, resetAll, size, prune, dispose, getStats };
}
