import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestRateLimiter, type RequestRateLimiter } from "./request-rate-limit.js";

describe("request rate limiter", () => {
  let limiter: RequestRateLimiter;

  afterEach(() => {
    limiter?.dispose();
  });

  // ---------- basic counting ----------

  it("allows requests when under the limit", () => {
    limiter = createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000 });
    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4); // 5 max - 1 counted
    expect(result.retryAfterMs).toBe(0);
  });

  it("decrements remaining count on each request", () => {
    limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check("10.0.0.1").remaining).toBe(2);
    expect(limiter.check("10.0.0.1").remaining).toBe(1);
    expect(limiter.check("10.0.0.1").remaining).toBe(0);
  });

  it("blocks after maxRequests is exceeded", () => {
    limiter = createRequestRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter.check("10.0.0.2").allowed).toBe(true);
    expect(limiter.check("10.0.0.2").allowed).toBe(true);

    const result = limiter.check("10.0.0.2");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  // ---------- window expiry ----------

  it("resets counter after the window expires", () => {
    vi.useFakeTimers();
    try {
      limiter = createRequestRateLimiter({ maxRequests: 2, windowMs: 10_000 });
      limiter.check("10.0.0.3");
      limiter.check("10.0.0.3");
      expect(limiter.check("10.0.0.3").allowed).toBe(false);

      vi.advanceTimersByTime(10_001);
      const result = limiter.check("10.0.0.3");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1); // fresh window, first request counted
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- per-IP isolation ----------

  it("tracks IPs independently", () => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.check("10.0.0.10");
    expect(limiter.check("10.0.0.10").allowed).toBe(false);

    // A different IP should be unaffected.
    expect(limiter.check("10.0.0.11").allowed).toBe(true);
  });

  it("treats ipv4 and ipv4-mapped ipv6 as the same client", () => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.check("1.2.3.4");
    expect(limiter.check("::ffff:1.2.3.4").allowed).toBe(false);
  });

  // ---------- loopback exemption ----------

  it.each(["127.0.0.1", "::1"])("exempts loopback address %s by default", (ip) => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.check(ip);
    // Should still be allowed even after exceeding maxRequests.
    expect(limiter.check(ip).allowed).toBe(true);
    expect(limiter.check(ip).remaining).toBe(1);
  });

  it("rate-limits loopback when exemptLoopback is false", () => {
    limiter = createRequestRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      exemptLoopback: false,
    });
    limiter.check("127.0.0.1");
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  // ---------- undefined / empty IP ----------

  it("normalizes undefined IP to 'unknown'", () => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.check(undefined);
    expect(limiter.check(undefined).allowed).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  // ---------- prune ----------

  it("prune removes expired window entries", () => {
    vi.useFakeTimers();
    try {
      limiter = createRequestRateLimiter({ maxRequests: 100, windowMs: 5_000 });
      limiter.check("10.0.0.30");
      expect(limiter.size()).toBe(1);

      vi.advanceTimersByTime(6_000);
      limiter.prune();
      expect(limiter.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prune keeps active window entries", () => {
    vi.useFakeTimers();
    try {
      limiter = createRequestRateLimiter({ maxRequests: 100, windowMs: 10_000 });
      limiter.check("10.0.0.31");

      vi.advanceTimersByTime(5_000); // Still within window.
      limiter.prune();
      expect(limiter.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- dispose ----------

  it("dispose clears all entries", () => {
    limiter = createRequestRateLimiter();
    limiter.check("10.0.0.40");
    expect(limiter.size()).toBe(1);
    limiter.dispose();
    expect(limiter.size()).toBe(0);
  });
});
