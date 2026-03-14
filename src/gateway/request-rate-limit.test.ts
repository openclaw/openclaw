import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestRateLimiter, type RequestRateLimiter } from "./request-rate-limit.js";

describe("request rate limiter", () => {
  let limiter: RequestRateLimiter;

  afterEach(() => {
    limiter?.dispose();
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    limiter = createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000, pruneIntervalMs: 0 });
    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("blocks requests over the limit", () => {
    limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000, pruneIntervalMs: 0 });
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    const blocked = limiter.check("10.0.0.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("exempts loopback by default", () => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, pruneIntervalMs: 0 });
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
  });

  it("does not exempt loopback when configured", () => {
    limiter = createRequestRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    });
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  it("tracks IPs independently", () => {
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, pruneIntervalMs: 0 });
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    expect(limiter.check("10.0.0.2").allowed).toBe(true);
    expect(limiter.check("10.0.0.1").allowed).toBe(false);
    expect(limiter.check("10.0.0.2").allowed).toBe(false);
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 1000, pruneIntervalMs: 0 });
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    expect(limiter.check("10.0.0.1").allowed).toBe(false);
    vi.advanceTimersByTime(1100);
    expect(limiter.check("10.0.0.1").allowed).toBe(true);
  });

  it("prune removes expired entries", () => {
    vi.useFakeTimers();
    limiter = createRequestRateLimiter({ maxRequests: 10, windowMs: 1000, pruneIntervalMs: 0 });
    limiter.check("10.0.0.1");
    expect(limiter.size()).toBe(1);
    vi.advanceTimersByTime(1100);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });
});
