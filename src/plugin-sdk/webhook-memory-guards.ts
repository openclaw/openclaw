import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveWebhookIntegerOption } from "./webhook-numeric-options.js";

type FixedWindowState = {
  count: number;
  windowStartMs: number;
};

type CounterState = {
  count: number;
  updatedAtMs: number;
};

export type FixedWindowRateLimiter = {
  /** Returns true when the key has exceeded the configured window budget. */
  isRateLimited: (key: string, nowMs?: number) => boolean;
  /** Number of currently tracked keys after expiry/cardinality pruning. */
  size: () => number;
  /** Drops all tracked key windows and resets pruning state. */
  clear: () => void;
};

export type BoundedCounter = {
  /** Increments a key and returns the current non-expired count. */
  increment: (key: string, nowMs?: number) => number;
  /** Number of currently tracked keys after TTL/cardinality pruning. */
  size: () => number;
  /** Drops all tracked counters and resets pruning state. */
  clear: () => void;
};

/** Default fixed-window budget for lightweight pre-body webhook throttling. */
export const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
});

/** Default memory budget and sample cadence for repeated webhook anomaly logs. */
export const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
});

/** Response statuses treated as noisy or suspicious webhook traffic by default. */
export const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([400, 401, 408, 413, 415, 429]);

export type WebhookAnomalyTracker = {
  record: (params: {
    /** Stable key for the source/category being sampled. */
    key: string;
    /** Response status code; untracked codes return zero without logging. */
    statusCode: number;
    /** Builds the sampled log line from the current count. */
    message: (count: number) => string;
    /** Optional logger called for the first event and configured sampling interval. */
    log?: (message: string) => void;
    /** Clock override used by tests and deterministic callers. */
    nowMs?: number;
  }) => number;
  /** Number of currently tracked anomaly keys. */
  size: () => number;
  /** Drops all anomaly counters. */
  clear: () => void;
};

/** Create a simple fixed-window rate limiter for in-memory webhook protection. */
export function createFixedWindowRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
  pruneIntervalMs?: number;
}): FixedWindowRateLimiter {
  const windowMs = resolveWebhookIntegerOption(
    options.windowMs,
    WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    {
      min: 1,
    },
  );
  const maxRequests = resolveWebhookIntegerOption(
    options.maxRequests,
    WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    { min: 1 },
  );
  const maxTrackedKeys = resolveWebhookIntegerOption(
    options.maxTrackedKeys,
    WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const pruneIntervalMs = resolveWebhookIntegerOption(options.pruneIntervalMs, windowMs, {
    min: 1,
  });
  const state = new Map<string, FixedWindowState>();
  let lastPruneMs = 0;

  const touch = (key: string, value: FixedWindowState) => {
    // Delete-then-set keeps the Map in LRU order for pruneMapToMaxSize, so
    // high-cardinality webhook sources evict the oldest active keys first.
    state.delete(key);
    state.set(key, value);
  };

  const prune = (nowMs: number) => {
    for (const [key, entry] of state) {
      if (nowMs - entry.windowStartMs >= windowMs) {
        state.delete(key);
      }
    }
  };

  return {
    isRateLimited: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return false;
      }
      if (nowMs - lastPruneMs >= pruneIntervalMs) {
        prune(nowMs);
        lastPruneMs = nowMs;
      }

      const existing = state.get(key);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        touch(key, { count: 1, windowStartMs: nowMs });
        pruneMapToMaxSize(state, maxTrackedKeys);
        return false;
      }

      const nextCount = existing.count + 1;
      touch(key, { count: nextCount, windowStartMs: existing.windowStartMs });
      pruneMapToMaxSize(state, maxTrackedKeys);
      return nextCount > maxRequests;
    },
    size: () => state.size,
    clear: () => {
      state.clear();
      lastPruneMs = 0;
    },
  };
}

/** Count keyed events in memory with optional TTL pruning and bounded cardinality. */
export function createBoundedCounter(options: {
  maxTrackedKeys: number;
  ttlMs?: number;
  pruneIntervalMs?: number;
}): BoundedCounter {
  const maxTrackedKeys = resolveWebhookIntegerOption(
    options.maxTrackedKeys,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const ttlMs = resolveWebhookIntegerOption(options.ttlMs, 0, { min: 0 });
  const pruneIntervalMs = resolveWebhookIntegerOption(
    options.pruneIntervalMs,
    ttlMs > 0 ? ttlMs : 60_000,
    { min: 1 },
  );
  const counters = new Map<string, CounterState>();
  let lastPruneMs = 0;

  const touch = (key: string, value: CounterState) => {
    // Delete-then-set keeps the Map in LRU order for pruneMapToMaxSize, while
    // updatedAtMs separately preserves TTL expiry semantics.
    counters.delete(key);
    counters.set(key, value);
  };

  const isExpired = (entry: CounterState, nowMs: number) =>
    ttlMs > 0 && nowMs - entry.updatedAtMs >= ttlMs;

  const prune = (nowMs: number) => {
    if (ttlMs > 0) {
      for (const [key, entry] of counters) {
        if (isExpired(entry, nowMs)) {
          counters.delete(key);
        }
      }
    }
  };

  return {
    increment: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return 0;
      }
      if (nowMs - lastPruneMs >= pruneIntervalMs) {
        prune(nowMs);
        lastPruneMs = nowMs;
      }

      const existing = counters.get(key);
      const baseCount = existing && !isExpired(existing, nowMs) ? existing.count : 0;
      const nextCount = baseCount + 1;
      touch(key, { count: nextCount, updatedAtMs: nowMs });
      pruneMapToMaxSize(counters, maxTrackedKeys);
      return nextCount;
    },
    size: () => counters.size,
    clear: () => {
      counters.clear();
      lastPruneMs = 0;
    },
  };
}

/** Track repeated webhook failures and emit sampled logs for suspicious request patterns. */
export function createWebhookAnomalyTracker(options?: {
  maxTrackedKeys?: number;
  ttlMs?: number;
  logEvery?: number;
  trackedStatusCodes?: readonly number[];
}): WebhookAnomalyTracker {
  const maxTrackedKeys = resolveWebhookIntegerOption(
    options?.maxTrackedKeys,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const ttlMs = resolveWebhookIntegerOption(
    options?.ttlMs,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
    { min: 0 },
  );
  const logEvery = resolveWebhookIntegerOption(
    options?.logEvery,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery,
    { min: 1 },
  );
  const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
  const counter = createBoundedCounter({ maxTrackedKeys, ttlMs });

  return {
    record: ({ key, statusCode, message, log, nowMs }) => {
      if (!trackedStatusCodes.has(statusCode)) {
        return 0;
      }
      const next = counter.increment(key, nowMs);
      // Log the first anomaly for visibility, then sample on the configured
      // cadence so repeated bad traffic does not flood plugin logs.
      if (log && (next === 1 || next % logEvery === 0)) {
        log(message(next));
      }
      return next;
    },
    size: () => counter.size(),
    clear: () => counter.clear(),
  };
}
