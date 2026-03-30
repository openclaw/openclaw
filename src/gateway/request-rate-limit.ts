/**
 * General-purpose per-IP request rate limiter for the gateway.
 *
 * Unlike the auth rate limiter (which tracks failed authentication attempts),
 * this module counts ALL incoming HTTP requests per client IP using a fixed
 * time window. It protects the gateway from request flooding when exposed
 * via Tailscale Funnel, a public reverse proxy, or any non-loopback binding.
 *
 * Design decisions:
 * - Fixed-window counter per IP – simple, low overhead, no per-request
 *   array allocations (unlike sliding window).
 * - Loopback addresses (127.0.0.1 / ::1) are exempt by default so that
 *   local CLI sessions are never throttled.
 * - Side-effect-free module: callers create an instance via
 *   {@link createRequestRateLimiter} and pass it where needed.
 */

import { isLoopbackAddress, resolveClientIp } from "./net.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestRateLimitConfig {
  /** Maximum requests per window.  @default 120 */
  maxRequests?: number;
  /** Window duration in milliseconds.  @default 60_000 (1 min) */
  windowMs?: number;
  /** Exempt loopback (localhost) addresses from rate limiting.  @default true */
  exemptLoopback?: boolean;
  /** Background prune interval in milliseconds; set <= 0 to disable.  @default 60_000 */
  pruneIntervalMs?: number;
}

export interface RequestRateLimitResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Number of remaining requests in the current window. */
  remaining: number;
  /** Milliseconds until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

export interface RequestRateLimiter {
  /** Check and count a request from the given IP. */
  check(ip: string | undefined): RequestRateLimitResult;
  /** Current number of tracked IPs. */
  size(): number;
  /** Remove expired window entries. */
  prune(): void;
  /** Dispose the limiter and cancel periodic cleanup timers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const PRUNE_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  windowStart: number;
}

export function createRequestRateLimiter(config?: RequestRateLimitConfig): RequestRateLimiter {
  const maxRequests = config?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const exemptLoopback = config?.exemptLoopback ?? true;
  const pruneIntervalMs = config?.pruneIntervalMs ?? PRUNE_INTERVAL_MS;

  const entries = new Map<string, WindowEntry>();

  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  if (pruneTimer?.unref) {
    pruneTimer.unref();
  }

  function normalizeIp(ip: string | undefined): string {
    return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
  }

  function isExempt(ip: string): boolean {
    return exemptLoopback && isLoopbackAddress(ip);
  }

  function check(rawIp: string | undefined): RequestRateLimitResult {
    const ip = normalizeIp(rawIp);
    if (isExempt(ip)) {
      return { allowed: true, remaining: maxRequests, retryAfterMs: 0 };
    }

    const now = Date.now();
    let entry = entries.get(ip);

    // New IP or window expired — start a fresh window.
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      entries.set(ip, entry);
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
  }

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - entry.windowStart >= windowMs) {
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

  return { check, size, prune, dispose };
}
