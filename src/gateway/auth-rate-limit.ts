import { LRUCache } from "lru-cache";

/**
 * Record of authentication failures for a specific IP address.
 */
type FailureRecord = {
  /** Number of consecutive failures */
  count: number;
  /** Timestamp of last failure */
  lastFailure: number;
  /** Timestamp until which this IP is blocked (if blocked) */
  blockedUntil?: number;
};

/**
 * LRU cache to track auth failures per IP.
 * Max 1000 IPs to prevent memory exhaustion.
 */
const failureCache = new LRUCache<string, FailureRecord>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour TTL for cache entries
});

/** Maximum failed attempts before blocking */
const MAX_ATTEMPTS = 5;

/** Duration to block an IP after exceeding max attempts (15 minutes) */
const BLOCK_DURATION_MS = 15 * 60 * 1000;

/** Time window to reset failure count (1 minute) */
const RESET_WINDOW_MS = 60 * 1000;

/**
 * Result of rate limit check.
 */
export type RateLimitCheckResult = {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: string;
  /** Remaining seconds until unblock (if blocked) */
  remainingSeconds?: number;
};

/**
 * Check if an IP address is rate limited.
 *
 * @param clientIp - Client IP address
 * @returns Rate limit check result
 */
export function checkRateLimit(clientIp: string): RateLimitCheckResult {
  const now = Date.now();
  const record = failureCache.get(clientIp);

  if (!record) {
    return { allowed: true };
  }

  // Check if IP is currently blocked
  if (record.blockedUntil && now < record.blockedUntil) {
    const remainingSec = Math.ceil((record.blockedUntil - now) / 1000);
    return {
      allowed: false,
      reason: `Too many failed authentication attempts. Try again in ${remainingSec}s.`,
      remainingSeconds: remainingSec,
    };
  }

  // Reset counter if enough time has passed since last failure
  if (now - record.lastFailure > RESET_WINDOW_MS) {
    failureCache.delete(clientIp);
    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * Record an authentication failure for an IP address.
 * If the IP exceeds MAX_ATTEMPTS, it will be blocked for BLOCK_DURATION_MS.
 *
 * @param clientIp - Client IP address
 */
export function recordAuthFailure(clientIp: string): void {
  const now = Date.now();
  const record = failureCache.get(clientIp) || {
    count: 0,
    lastFailure: now,
  };

  record.count += 1;
  record.lastFailure = now;

  // Block IP if it exceeds max attempts
  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
  }

  failureCache.set(clientIp, record);
}

/**
 * Record a successful authentication for an IP address.
 * This resets the failure counter for that IP.
 *
 * @param clientIp - Client IP address
 */
export function recordAuthSuccess(clientIp: string): void {
  failureCache.delete(clientIp);
}

/**
 * Get current failure count for an IP (for testing/debugging).
 *
 * @param clientIp - Client IP address
 * @returns Current failure count, or 0 if no record exists
 */
export function getFailureCount(clientIp: string): number {
  return failureCache.get(clientIp)?.count ?? 0;
}

/**
 * Clear all rate limit records (for testing).
 */
export function clearRateLimitCache(): void {
  failureCache.clear();
}
