import { pruneMapToMaxSize } from "../infra/map-size.js";

type FixedWindowState = {
  count: number;
  windowStartMs: number;
};

type CounterState = {
  count: number;
  updatedAtMs: number;
};

export type FixedWindowRateLimiter = {
  isRateLimited: (key: string, nowMs?: number) => boolean;
  size: () => number;
  clear: () => void;
};

export type BoundedCounter = {
  increment: (key: string, nowMs?: number) => number;
  size: () => number;
  clear: () => void;
};

export const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4_096,
});

export const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
  maxTrackedKeys: 4_096,
  ttlMs: 6 * 60 * 60_000,
  logEvery: 25,
});

export const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([400, 401, 408, 413, 415, 429]);

export type WebhookAnomalyTracker = {
  record: (params: {
    key: string;
    statusCode: number;
    message: (count: number) => string;
    log?: (message: string) => void;
    nowMs?: number;
  }) => number;
  size: () => number;
  clear: () => void;
};

export function createFixedWindowRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
  pruneIntervalMs?: number;
}): FixedWindowRateLimiter {
  const windowMs = Math.max(1, Math.floor(options.windowMs));
  const maxRequests = Math.max(1, Math.floor(options.maxRequests));
  const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
  const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? windowMs));
  const state = new Map<string, FixedWindowState>();
  let lastPruneMs = 0;

  const touch = (key: string, value: FixedWindowState) => {
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

export function createBoundedCounter(options: {
  maxTrackedKeys: number;
  ttlMs?: number;
  pruneIntervalMs?: number;
}): BoundedCounter {
  const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
  const ttlMs = Math.max(0, Math.floor(options.ttlMs ?? 0));
  const pruneIntervalMs = Math.max(
    1,
    Math.floor(options.pruneIntervalMs ?? (ttlMs > 0 ? ttlMs : 60_000)),
  );
  const counters = new Map<string, CounterState>();
  let lastPruneMs = 0;

  const touch = (key: string, value: CounterState) => {
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

export function createWebhookAnomalyTracker(options?: {
  maxTrackedKeys?: number;
  ttlMs?: number;
  logEvery?: number;
  trackedStatusCodes?: readonly number[];
}): WebhookAnomalyTracker {
  const maxTrackedKeys = Math.max(
    1,
    Math.floor(options?.maxTrackedKeys ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys),
  );
  const ttlMs = Math.max(0, Math.floor(options?.ttlMs ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs));
  const logEvery = Math.max(
    1,
    Math.floor(options?.logEvery ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery),
  );
  const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
  const counter = createBoundedCounter({ maxTrackedKeys, ttlMs });

  return {
    record: ({ key, statusCode, message, log, nowMs }) => {
      if (!trackedStatusCodes.has(statusCode)) {
        return 0;
      }
      const next = counter.increment(key, nowMs);
      if (log && (next === 1 || next % logEvery === 0)) {
        log(message(next));
      }
      return next;
    },
    size: () => counter.size(),
    clear: () => counter.clear(),
  };
}
