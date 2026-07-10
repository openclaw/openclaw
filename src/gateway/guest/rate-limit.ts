import { createHash } from "node:crypto";
import {
  buildRateLimitIdentityKey,
  createAuthRateLimiter,
  type AuthRateLimiter,
  type RateLimitConfig,
} from "../auth-rate-limit.js";

const SHARE_CODE_ALPHABET_SIZE = 32;
const SHARE_CODE_CHARACTER_COUNT = 6;

export const GUEST_SHARE_CODE_SPACE_SIZE = SHARE_CODE_ALPHABET_SIZE ** SHARE_CODE_CHARACTER_COUNT;
export const GUEST_REDEEM_IP_MAX_ATTEMPTS = 10;
export const GUEST_REDEEM_IP_WINDOW_MS = 60_000;
export const GUEST_REDEEM_IP_LOCKOUT_MS = 5 * 60_000;
export const GUEST_REDEEM_CODE_MAX_ATTEMPTS = 5;
export const GUEST_REDEEM_CODE_WINDOW_MS = 5 * 60_000;
export const GUEST_REDEEM_CODE_LOCKOUT_MS = 15 * 60_000;

export type GuestRedeemRateLimitOptions = {
  ip?: RateLimitConfig;
  code?: RateLimitConfig;
};

export type GuestRedeemLimitCheck = {
  allowed: boolean;
  retryAfterMs: number;
};

export type GuestRedeemLockout = {
  dimension: "ip" | "code";
  retryAfterMs: number;
};

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

/** Computes the fastest exhaustive search at the configured per-IP attempt rate. */
export function calculateGuestCodeExhaustionMs(params: {
  codeSpaceSize: number;
  maxAttemptsPerWindow: number;
  windowMs: number;
}): number {
  const codeSpaceSize = positiveFinite(params.codeSpaceSize, "codeSpaceSize");
  const maxAttempts = positiveFinite(params.maxAttemptsPerWindow, "maxAttemptsPerWindow");
  const windowMs = positiveFinite(params.windowMs, "windowMs");
  return Math.ceil(codeSpaceSize / maxAttempts) * windowMs;
}

function codeRateLimitKey(code: string): string {
  const digest = createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
  return buildRateLimitIdentityKey("guest-code", digest);
}

function createLimiter(config: RateLimitConfig): AuthRateLimiter {
  return createAuthRateLimiter({
    ...config,
    exemptLoopback: false,
  });
}

export class GuestRedeemRateLimiter {
  private readonly ipLimiter: AuthRateLimiter;
  private readonly codeLimiter: AuthRateLimiter;

  constructor(options: GuestRedeemRateLimitOptions = {}) {
    this.ipLimiter = createLimiter({
      maxAttempts: GUEST_REDEEM_IP_MAX_ATTEMPTS,
      windowMs: GUEST_REDEEM_IP_WINDOW_MS,
      lockoutMs: GUEST_REDEEM_IP_LOCKOUT_MS,
      ...options.ip,
    });
    this.codeLimiter = createLimiter({
      maxAttempts: GUEST_REDEEM_CODE_MAX_ATTEMPTS,
      windowMs: GUEST_REDEEM_CODE_WINDOW_MS,
      lockoutMs: GUEST_REDEEM_CODE_LOCKOUT_MS,
      ...options.code,
    });
  }

  check(clientIp: string | undefined, code: string): GuestRedeemLimitCheck {
    const ip = this.ipLimiter.check(clientIp);
    const codeResult = this.codeLimiter.check(codeRateLimitKey(code));
    return {
      allowed: ip.allowed && codeResult.allowed,
      retryAfterMs: Math.max(ip.retryAfterMs, codeResult.retryAfterMs),
    };
  }

  recordFailure(clientIp: string | undefined, code: string): GuestRedeemLockout[] {
    const codeKey = codeRateLimitKey(code);
    const ipBefore = this.ipLimiter.check(clientIp);
    const codeBefore = this.codeLimiter.check(codeKey);
    this.ipLimiter.recordFailure(clientIp);
    this.codeLimiter.recordFailure(codeKey);
    const ipAfter = this.ipLimiter.check(clientIp);
    const codeAfter = this.codeLimiter.check(codeKey);
    const lockouts: GuestRedeemLockout[] = [];
    if (ipBefore.allowed && !ipAfter.allowed) {
      lockouts.push({ dimension: "ip", retryAfterMs: ipAfter.retryAfterMs });
    }
    if (codeBefore.allowed && !codeAfter.allowed) {
      lockouts.push({ dimension: "code", retryAfterMs: codeAfter.retryAfterMs });
    }
    return lockouts;
  }

  resetIp(clientIp: string | undefined): void {
    this.ipLimiter.reset(clientIp);
  }

  close(): void {
    this.ipLimiter.dispose();
    this.codeLimiter.dispose();
  }
}
