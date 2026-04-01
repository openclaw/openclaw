import type { GatewayClient } from "./server-methods/types.js";

// Defaults — can be overridden via gateway.controlPlane.rateLimit config.
const DEFAULT_CONTROL_PLANE_MAX_REQUESTS = 3;
const DEFAULT_CONTROL_PLANE_WINDOW_MS = 60_000;

let controlPlaneMaxRequests = DEFAULT_CONTROL_PLANE_MAX_REQUESTS;
let controlPlaneWindowMs = DEFAULT_CONTROL_PLANE_WINDOW_MS;

/**
 * Apply control-plane rate limit configuration.
 * Called once during gateway startup with config from openclaw.json.
 * Clears existing buckets so new limits take effect immediately.
 */
export function configureControlPlaneRateLimit(config?: {
  maxRequests?: number;
  windowMs?: number;
}): void {
  controlPlaneMaxRequests = config?.maxRequests ?? DEFAULT_CONTROL_PLANE_MAX_REQUESTS;
  controlPlaneWindowMs = config?.windowMs ?? DEFAULT_CONTROL_PLANE_WINDOW_MS;
  controlPlaneBuckets.clear();
}

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
  maxRequests: number;
  windowMs: number;
} {
  const nowMs = params.nowMs ?? Date.now();
  const key = resolveControlPlaneRateLimitKey(params.client);
  const bucket = controlPlaneBuckets.get(key);

  if (!bucket || nowMs - bucket.windowStartMs >= controlPlaneWindowMs) {
    controlPlaneBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: controlPlaneMaxRequests - 1,
      key,
      maxRequests: controlPlaneMaxRequests,
      windowMs: controlPlaneWindowMs,
    };
  }

  if (bucket.count >= controlPlaneMaxRequests) {
    const retryAfterMs = Math.max(0, bucket.windowStartMs + controlPlaneWindowMs - nowMs);
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      key,
      maxRequests: controlPlaneMaxRequests,
      windowMs: controlPlaneWindowMs,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, controlPlaneMaxRequests - bucket.count),
    key,
    maxRequests: controlPlaneMaxRequests,
    windowMs: controlPlaneWindowMs,
  };
}

export const __testing = {
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
    controlPlaneMaxRequests = DEFAULT_CONTROL_PLANE_MAX_REQUESTS;
    controlPlaneWindowMs = DEFAULT_CONTROL_PLANE_WINDOW_MS;
  },
  configureControlPlaneRateLimit,
};
