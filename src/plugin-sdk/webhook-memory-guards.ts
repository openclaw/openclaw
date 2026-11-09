// Webhook memory guards keep in-process webhook dedupe and replay state bounded.
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { pruneMapToMaxSize } from "../infra/map-size.js";

type FixedWindowState = {
  count: number;
  windowStartMs: number;
};

type CounterState = {
  count: number;
  updatedAtMs: number;
};

/** In-memory fixed-window limiter used by webhook ingress handlers. */
export type FixedWindowRateLimiter = {
  /** Return true once the key exceeds its allowed request count in the current window. */
  isRateLimited: (key: string, nowMs?: number) => boolean;
  /** Number of tracked keys currently retained in memory. */
  size: () => number;
  /** Drop all tracked keys and reset pruning state. */
  clear: () => void;
};

/** Bounded keyed counter for sampled webhook anomaly tracking. */
export type BoundedCounter = {
  /** Increment one key and return its current count, or zero for empty keys. */
  increment: (key: string, nowMs?: number) => number;
  /** Number of tracked keys currently retained in memory. */
  size: () => number;
  /** Drop all tracked keys and reset pruning state. */
  clear: () => void;
};

/** Default webhook ingress rate-limit settings for plugin monitors. */
export const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
});

/** Default cardinality and sampling settings for webhook anomaly counters. */
export const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
});

/** HTTP status codes counted as anomalous webhook request outcomes. */
export const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([400, 401, 408, 413, 415, 429]);

/** Records repeated webhook failures and exposes bounded in-memory state controls. */
export type WebhookAnomalyTracker = {
  /** Count one tracked status for a key; returns zero when the status/key is ignored. */
  record: (params: {
    /** Stable anomaly key, typically route plus sender or remote identity. */
    key: string;
    /** HTTP status to count when it is in the tracked status-code set. */
    statusCode: number;
    /** Build the sampled log message from the current key count. */
    message: (count: number) => string;
    /** Optional log sink invoked for the first hit and every sampled repeat. */
    log?: (message: string) => void;
    /** Clock override for deterministic tests. */
    nowMs?: number;
  }) => number;
  /** Number of tracked anomaly keys currently retained in memory. */
  size: () => number;
  /** Drop all tracked anomaly keys and reset pruning state. */
  clear: () => void;
};

function createBoundedTimedMap<T>(
  maxTrackedKeys: number,
  pruneIntervalMs: number,
  isExpired?: (entry: T, nowMs: number) => boolean,
) {
  const entries = new Map<string, T>();
  let lastPruneMs = 0;
  return {
    get(key: string, nowMs: number) {
      if (isExpired && nowMs - lastPruneMs >= pruneIntervalMs) {
        for (const [entryKey, entry] of entries) {
          if (isExpired(entry, nowMs)) {
            entries.delete(entryKey);
          }
        }
        lastPruneMs = nowMs;
      }
      return entries.get(key);
    },
    touch(key: string, value: T) {
      // Refresh before pruning so active keys outlive stale one-off probes.
      entries.delete(key);
      entries.set(key, value);
      pruneMapToMaxSize(entries, maxTrackedKeys);
    },
    size: () => entries.size,
    clear() {
      entries.clear();
      lastPruneMs = 0;
    },
  };
}

/** Create a simple fixed-window rate limiter for in-memory webhook protection. */
export function createFixedWindowRateLimiter(options: {
  /** Duration of one fixed window in milliseconds. */
  windowMs: number;
  /** Maximum accepted requests per key during one window. */
  maxRequests: number;
  /** Maximum number of keys retained before oldest entries are pruned. */
  maxTrackedKeys: number;
  /** Optional interval for expired-window pruning. Defaults to `windowMs`. */
  pruneIntervalMs?: number;
}): FixedWindowRateLimiter {
  const windowMs = resolveIntegerOption(options.windowMs, WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs, {
    min: 1,
  });
  const maxRequests = resolveIntegerOption(
    options.maxRequests,
    WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    { min: 1 },
  );
  const maxTrackedKeys = resolveIntegerOption(
    options.maxTrackedKeys,
    WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const pruneIntervalMs = resolveIntegerOption(options.pruneIntervalMs, windowMs, {
    min: 1,
  });
  const state = createBoundedTimedMap<FixedWindowState>(
    maxTrackedKeys,
    pruneIntervalMs,
    (entry, nowMs) => nowMs - entry.windowStartMs >= windowMs,
  );

  return {
    isRateLimited: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return false;
      }
      const existing = state.get(key, nowMs);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        state.touch(key, { count: 1, windowStartMs: nowMs });
        return false;
      }

      const nextCount = existing.count + 1;
      state.touch(key, { count: nextCount, windowStartMs: existing.windowStartMs });
      return nextCount > maxRequests;
    },
    size: state.size,
    clear: () => state.clear(),
  };
}

/** Count keyed events in memory with optional TTL pruning and bounded cardinality. */
export function createBoundedCounter(options: {
  /** Maximum number of keys retained before oldest entries are pruned. */
  maxTrackedKeys: number;
  /** Optional key TTL in milliseconds; zero disables TTL expiry. */
  ttlMs?: number;
  /** Optional interval for TTL pruning. */
  pruneIntervalMs?: number;
}): BoundedCounter {
  const maxTrackedKeys = resolveIntegerOption(
    options.maxTrackedKeys,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const ttlMs = resolveIntegerOption(options.ttlMs, 0, { min: 0 });
  const pruneIntervalMs = resolveIntegerOption(
    options.pruneIntervalMs,
    ttlMs > 0 ? ttlMs : 60_000,
    { min: 1 },
  );
  const isExpired = (entry: CounterState, nowMs: number) =>
    ttlMs > 0 && nowMs - entry.updatedAtMs >= ttlMs;
  const counters = createBoundedTimedMap<CounterState>(
    maxTrackedKeys,
    pruneIntervalMs,
    ttlMs > 0 ? isExpired : undefined,
  );

  return {
    increment: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return 0;
      }
      const existing = counters.get(key, nowMs);
      const baseCount = existing && !isExpired(existing, nowMs) ? existing.count : 0;
      const nextCount = baseCount + 1;
      counters.touch(key, { count: nextCount, updatedAtMs: nowMs });
      return nextCount;
    },
    size: counters.size,
    clear: () => counters.clear(),
  };
}

/** Track repeated webhook failures and emit sampled logs for suspicious request patterns. */
export function createWebhookAnomalyTracker(options?: {
  /** Maximum number of anomaly keys retained before oldest entries are pruned. */
  maxTrackedKeys?: number;
  /** Key TTL in milliseconds; zero disables TTL expiry. */
  ttlMs?: number;
  /** Log every Nth repeat after the first hit. */
  logEvery?: number;
  /** HTTP status codes that should be counted as anomalies. */
  trackedStatusCodes?: readonly number[];
}): WebhookAnomalyTracker {
  const maxTrackedKeys = resolveIntegerOption(
    options?.maxTrackedKeys,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const ttlMs = resolveIntegerOption(options?.ttlMs, WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs, {
    min: 0,
  });
  const logEvery = resolveIntegerOption(
    options?.logEvery,
    WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery,
    { min: 1 },
  );
  const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
  const counter = createBoundedCounter({ maxTrackedKeys, ttlMs });

  return {
    record: ({ key, statusCode, message, log, nowMs }) => {
      if (!key || !trackedStatusCodes.has(statusCode)) {
        return 0;
      }
      const next = counter.increment(key, nowMs);
      if (log && (next === 1 || next % logEvery === 0)) {
        // Log the first hit for visibility, then sample repeated failures to avoid noisy bursts.
        log(message(next));
      }
      return next;
    },
    size: counter.size,
    clear: counter.clear,
  };
}
