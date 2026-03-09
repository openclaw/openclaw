import type { GatewayClient } from "./server-methods/types.js";

const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = 3;
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

type Bucket = {
  count: number;
  windowStartMs: number;
};

const controlPlaneBuckets = new Map<string, Bucket>();

// Periodic cleanup to avoid unbounded map growth.
let pruneTimer: ReturnType<typeof setInterval> | null = setInterval(
  () => pruneControlPlaneRateLimiter(),
  PRUNE_INTERVAL_MS,
);
// Allow the Node.js process to exit even if the timer is still active.
if (pruneTimer?.unref) {
  pruneTimer.unref();
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
    controlPlaneBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
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

/** Remove expired buckets whose window has fully elapsed. */
export function pruneControlPlaneRateLimiter(nowMs?: number): void {
  const now = nowMs ?? Date.now();
  for (const [key, bucket] of controlPlaneBuckets) {
    if (now - bucket.windowStartMs >= CONTROL_PLANE_RATE_LIMIT_WINDOW_MS) {
      controlPlaneBuckets.delete(key);
    }
  }
}

/** Return the current number of tracked buckets (useful for diagnostics). */
export function controlPlaneRateLimiterSize(): number {
  return controlPlaneBuckets.size;
}

/** Dispose the limiter: clear all buckets and cancel the periodic prune timer. */
export function disposeControlPlaneRateLimiter(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  controlPlaneBuckets.clear();
}

export const __testing = {
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
    // Reset the prune timer so tests don't leak intervals.
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    pruneTimer = setInterval(() => pruneControlPlaneRateLimiter(), PRUNE_INTERVAL_MS);
    if (pruneTimer?.unref) {
      pruneTimer.unref();
    }
  },
};
