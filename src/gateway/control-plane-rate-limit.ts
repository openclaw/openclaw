import type { GatewayClient } from "./server-methods/types.js";

const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3;
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Maximum number of tracked rate-limit keys. Once exceeded, all expired
 * buckets are pruned. If still over the cap after pruning, the oldest
 * entries are evicted to stay within bounds. This prevents unbounded
 * memory growth when many unique device/IP combinations connect over time.
 */
const CONTROL_PLANE_MAX_TRACKED_KEYS = 4_096;

type Bucket = {
  count: number;
  windowStartMs: number;
};

const controlPlaneBuckets = new Map<string, Bucket>();

/**
 * Prune expired buckets and enforce the size cap.
 * Called on every write to keep memory usage bounded.
 */
function pruneControlPlaneBuckets(nowMs: number): void {
  if (controlPlaneBuckets.size <= CONTROL_PLANE_MAX_TRACKED_KEYS) {
    return;
  }

  // First pass: remove all expired entries.
  for (const [key, bucket] of controlPlaneBuckets) {
    if (nowMs - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
      controlPlaneBuckets.delete(key);
    }
  }

  // Second pass: if still over the cap, evict oldest entries (Map iteration
  // order is insertion order, so the first entries are the oldest).
  if (controlPlaneBuckets.size > CONTROL_PLANE_MAX_TRACKED_KEYS) {
    const excess = controlPlaneBuckets.size - CONTROL_PLANE_MAX_TRACKED_KEYS;
    let removed = 0;
    for (const key of controlPlaneBuckets.keys()) {
      if (removed >= excess) {
        break;
      }
      controlPlaneBuckets.delete(key);
      removed += 1;
    }
  }
}

function normalizePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveControlPlaneRateLimitKey(client: GatewayClient | null): string {
  const deviceId = normalizePart(client?.connect?.device?.id, "unknown-device");
  const clientIp = normalizePart(client?.clientIp, "unknown-ip");
  if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
    // Last-resort fallback: avoid cross-client contention when upstream identity is missing.
    const connId = normalizePart(client?.connId, "");
    if (connId) {
      return `${deviceId}|${clientIp}|conn=${connId}`;
    }
  }
  return `${deviceId}|${clientIp}`;
}

export function consumeControlPlaneWriteBudget(params: {
  client: GatewayClient | null;
  nowMs?: number;
}): {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  key: string;
} {
  const nowMs = params.nowMs ?? Date.now();
  const key = resolveControlPlaneRateLimitKey(params.client);
  const bucket = controlPlaneBuckets.get(key);

  if (!bucket || nowMs - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
    // Delete before set so the key moves to the tail of Map iteration order.
    // This ensures FIFO eviction targets the least-recently-active client,
    // not the one that happened to first connect earliest.
    controlPlaneBuckets.delete(key);
    controlPlaneBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
    pruneControlPlaneBuckets(nowMs);
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
      key,
    };
  }

  if (bucket.count >= CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = Math.max(
      0,
      bucket.windowStartMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - nowMs,
    );
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      key,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - bucket.count),
    key,
  };
}

export const __testing = {
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
  },
  controlPlaneBucketsSize() {
    return controlPlaneBuckets.size;
  },
  CONTROL_PLANE_MAX_TRACKED_KEYS,
};
