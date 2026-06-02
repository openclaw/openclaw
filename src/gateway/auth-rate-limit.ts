import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { isLoopbackAddress, resolveClientIp } from "./net.js";

/** Runtime knobs for one in-memory Gateway auth limiter instance. */
export interface RateLimitConfig {
  /** Maximum failed attempts before blocking.  @default 10 */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds.     @default 60_000 (1 min) */
  windowMs?: number;
  /** Lockout duration in milliseconds after the limit is exceeded.  @default 300_000 (5 min) */
  lockoutMs?: number;
  /** Exempt loopback (localhost) addresses from rate limiting.  @default true */
  exemptLoopback?: boolean;
  /** Background prune interval in milliseconds; set <= 0 to disable auto-prune.  @default 60_000 */
  pruneIntervalMs?: number;
}

export const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
export const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
export const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
// Per-IP gate for the pre-auth bootstrap-token verify path.
// `verifyDeviceBootstrapToken` is `withLock`-serialized in
// `device-bootstrap.ts` and runs fs read + fs write on every attempt;
// without a scope-specific limiter, attackers presenting a valid
// device signature can queue the bootstrap-pairing flow behind their
// requests, blocking legitimate node onboarding during the attack.
export const AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN = "bootstrap-token";
export const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";

interface RateLimitEntry {
  /** Timestamps (epoch ms) of recent failed attempts inside the window. */
  attempts: number[];
  /** If set, requests from this IP are blocked until this epoch-ms instant. */
  lockedUntil?: number;
}

export interface RateLimitCheckResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Number of remaining attempts before the limit is reached. */
  remaining: number;
  /** Milliseconds until the lockout expires (0 when not locked). */
  retryAfterMs: number;
}

/** Sliding-window auth limiter shared by HTTP, WebSocket, and hook surfaces. */
export interface AuthRateLimiter {
  /** Check whether `ip` is currently allowed to attempt authentication. */
  check(ip: string | undefined, scope?: string): RateLimitCheckResult;
  /** Record a failed authentication attempt for `ip`. */
  recordFailure(ip: string | undefined, scope?: string): void;
  /** Reset the rate-limit state for `ip` (e.g. after a successful login). */
  reset(ip: string | undefined, scope?: string): void;
  /** Return the current number of tracked IPs (useful for diagnostics). */
  size(): number;
  /** Remove expired entries and release memory. */
  prune(): void;
  /** Dispose the limiter and cancel periodic cleanup timers. */
  dispose(): void;
}

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_LOCKOUT_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // prune stale entries every minute

/**
 * Canonicalize client IPs used for auth throttling so all call sites
 * share one representation (including IPv4-mapped IPv6 forms).
 */
export function normalizeRateLimitClientIp(ip: string | undefined): string {
  if (typeof ip === "string" && ip.startsWith(BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX)) {
    return ip;
  }
  return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
}

function resolvePruneIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return PRUNE_INTERVAL_MS;
  }
  if (Number.isFinite(value) && value <= 0) {
    return 0;
  }
  return resolveTimerTimeoutMs(value, PRUNE_INTERVAL_MS);
}

/**
 * Create a process-local sliding-window limiter keyed by `{scope, clientIp}`.
 *
 * Scopes isolate credential classes that share an IP, while the periodic prune
 * keeps failed-login maps bounded for long-lived Gateway processes.
 */
export function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = resolveTimerTimeoutMs(config?.windowMs, DEFAULT_WINDOW_MS, 0);
  const lockoutMs = resolveTimerTimeoutMs(config?.lockoutMs, DEFAULT_LOCKOUT_MS, 0);
  const exemptLoopback = config?.exemptLoopback ?? true;
  const pruneIntervalMs = resolvePruneIntervalMs(config?.pruneIntervalMs);

  const entries = new Map<string, RateLimitEntry>();

  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  if (pruneTimer?.unref) {
    pruneTimer.unref();
  }

  function normalizeScope(scope: string | undefined): string {
    return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
  }

  function normalizeIp(ip: string | undefined): string {
    return normalizeRateLimitClientIp(ip);
  }

  function resolveKey(
    rawIp: string | undefined,
    rawScope: string | undefined,
  ): {
    key: string;
    ip: string;
  } {
    const ip = normalizeIp(rawIp);
    const scope = normalizeScope(rawScope);
    return { key: `${scope}:${ip}`, ip };
  }

  function isExempt(ip: string): boolean {
    return exemptLoopback && isLoopbackAddress(ip);
  }

  function slideWindow(entry: RateLimitEntry, now: number): void {
    const cutoff = now - windowMs;
    // Remove attempts that fell outside the window.
    entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
  }

  function check(rawIp: string | undefined, rawScope?: string): RateLimitCheckResult {
    const { key, ip } = resolveKey(rawIp, rawScope);
    // Local CLI/control paths must not lock themselves out while recovering
    // Gateway auth config; public surfaces opt out with `exemptLoopback: false`.
    if (isExempt(ip)) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    const now = Date.now();
    const entry = entries.get(key);

    if (!entry) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    if (entry.lockedUntil && now < entry.lockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.lockedUntil - now,
      };
    }

    if (entry.lockedUntil && now >= entry.lockedUntil) {
      entry.lockedUntil = undefined;
      entry.attempts = [];
    }

    slideWindow(entry, now);
    const remaining = Math.max(0, maxAttempts - entry.attempts.length);
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  function recordFailure(rawIp: string | undefined, rawScope?: string): void {
    const { key, ip } = resolveKey(rawIp, rawScope);
    // Mirror `check` so exempt callers do not accumulate stale entries that
    // later become active if config changes within the same process.
    if (isExempt(ip)) {
      return;
    }

    const now = Date.now();
    let entry = entries.get(key);

    if (!entry) {
      entry = { attempts: [] };
      entries.set(key, entry);
    }

    // Locked callers stay on the original retry deadline; repeated failures
    // during lockout should not starve legitimate follow-up attempts forever.
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return;
    }

    slideWindow(entry, now);
    entry.attempts.push(now);

    if (entry.attempts.length >= maxAttempts) {
      entry.lockedUntil = now + lockoutMs;
    }
  }

  function reset(rawIp: string | undefined, rawScope?: string): void {
    const { key } = resolveKey(rawIp, rawScope);
    entries.delete(key);
  }

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      // If locked out, keep the entry until the lockout expires.
      if (entry.lockedUntil && now < entry.lockedUntil) {
        continue;
      }
      slideWindow(entry, now);
      if (entry.attempts.length === 0) {
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

  return { check, recordFailure, reset, size, prune, dispose };
}
