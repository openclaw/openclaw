/**
 * Per-IP request-level rate limiter for the gateway.
 *
 * Uses a sliding window counter (similar to auth-rate-limit.ts) to cap the
 * number of HTTP requests per IP within a configurable time window. Loopback
 * addresses are optionally exempt (default: true).
 */

import { isLoopbackAddress, resolveClientIp } from "./net.js";

export interface RequestRateLimitConfig {
  /** Maximum requests per IP per window.  @default 120 */
  maxRequests?: number;
  /** Window duration in milliseconds.  @default 60_000 (1 min) */
  windowMs?: number;
  /** Exempt loopback (localhost) addresses.  @default true */
  exemptLoopback?: boolean;
  /** Background prune interval in milliseconds; set <= 0 to disable.  @default 60_000 */
  pruneIntervalMs?: number;
}

export interface RequestRateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface WindowEntry {
  timestamps: number[];
}

export interface RequestRateLimiter {
  /** Check and record a request from `ip`. Returns whether it is allowed. */
  check(ip: string | undefined): RequestRateLimitCheckResult;
  /** Return the current number of tracked IPs. */
  size(): number;
  /** Remove expired entries. */
  prune(): void;
  /** Dispose the limiter and cancel periodic cleanup timers. */
  dispose(): void;
}

const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

function normalizeIp(ip: string | undefined): string {
  return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
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

  function slideWindow(entry: WindowEntry, now: number): void {
    const cutoff = now - windowMs;
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
  }

  function check(rawIp: string | undefined): RequestRateLimitCheckResult {
    const ip = normalizeIp(rawIp);

    if (exemptLoopback && isLoopbackAddress(ip)) {
      return { allowed: true, remaining: maxRequests, retryAfterMs: 0 };
    }

    const now = Date.now();
    let entry = entries.get(ip);

    if (!entry) {
      entry = { timestamps: [] };
      entries.set(ip, entry);
    }

    slideWindow(entry, now);
    const remaining = Math.max(0, maxRequests - entry.timestamps.length);

    if (remaining <= 0) {
      // Find earliest timestamp in window to compute retry-after.
      const earliest = entry.timestamps[0] ?? now;
      const retryAfterMs = Math.max(0, earliest + windowMs - now);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    entry.timestamps.push(now);
    return { allowed: true, remaining: remaining - 1, retryAfterMs: 0 };
  }

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      slideWindow(entry, now);
      if (entry.timestamps.length === 0) {
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
