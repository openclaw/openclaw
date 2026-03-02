import type { GatewayClient } from "./server-methods/types.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(
  process.env.OPENCLAW_CONTROL_PLANE_WRITE_MAX_REQUESTS,
  10,
);
const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS = 60_000;

type Bucket = {
  count: number;
  windowStartMs: number;
};

const controlPlaneBuckets = new Map<string, Bucket>();

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
  const connId = normalizePart(client?.connId, "");
  if ((deviceId === "unknown-device" || clientIp === "unknown-ip") && connId) {
    // Reduce accidental bucket sharing when caller identity is incomplete.
    return `${deviceId}|${clientIp}|conn=${connId}`;
  }
  return `${deviceId}|${clientIp}`;
}

// Evict stale buckets whose window has long expired to prevent unbounded map growth.
// Called on each write so cleanup happens lazily without a separate interval.
function pruneExpiredBuckets(nowMs: number): void {
  if (controlPlaneBuckets.size < 256) {
    return; // Skip until the map is large enough to warrant pruning
  }
  const cutoff = nowMs - CONTROL_PLANE_RATE_LIMIT_WINDOW_MS * 2;
  for (const [k, b] of controlPlaneBuckets) {
    if (b.windowStartMs < cutoff) {
      controlPlaneBuckets.delete(k);
    }
  }
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
  pruneExpiredBuckets(nowMs);
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

export const __testing = {
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
  },
};
