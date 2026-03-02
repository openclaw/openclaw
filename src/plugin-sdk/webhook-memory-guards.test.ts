import { describe, expect, it } from "vitest";
import { createBoundedCounter, createFixedWindowRateLimiter } from "./webhook-memory-guards.js";

describe("createFixedWindowRateLimiter", () => {
  it("enforces a fixed-window request limit", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      maxTrackedKeys: 100,
    });

    expect(limiter.isRateLimited("k", 1_000)).toBe(false);
    expect(limiter.isRateLimited("k", 1_001)).toBe(false);
    expect(limiter.isRateLimited("k", 1_002)).toBe(false);
    expect(limiter.isRateLimited("k", 1_003)).toBe(true);
  });

  it("resets counters after the window elapses", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 10,
      maxRequests: 1,
      maxTrackedKeys: 100,
    });

    expect(limiter.isRateLimited("k", 100)).toBe(false);
    expect(limiter.isRateLimited("k", 101)).toBe(true);
    expect(limiter.isRateLimited("k", 111)).toBe(false);
  });

  it("caps tracked keys", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      maxTrackedKeys: 5,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.isRateLimited(`key-${i}`, 1_000 + i);
    }

    expect(limiter.size()).toBeLessThanOrEqual(5);
  });

  it("prunes stale keys", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 10,
      maxRequests: 10,
      maxTrackedKeys: 100,
      pruneIntervalMs: 10,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.isRateLimited(`key-${i}`, 100);
    }
    expect(limiter.size()).toBe(20);

    limiter.isRateLimited("fresh", 120);
    expect(limiter.size()).toBe(1);
  });
});

describe("createBoundedCounter", () => {
  it("increments and returns per-key counts", () => {
    const counter = createBoundedCounter({ maxTrackedKeys: 100 });

    expect(counter.increment("k", 1_000)).toBe(1);
    expect(counter.increment("k", 1_001)).toBe(2);
    expect(counter.increment("k", 1_002)).toBe(3);
  });

  it("caps tracked keys", () => {
    const counter = createBoundedCounter({ maxTrackedKeys: 3 });

    for (let i = 0; i < 10; i += 1) {
      counter.increment(`k-${i}`, 1_000 + i);
    }

    expect(counter.size()).toBeLessThanOrEqual(3);
  });

  it("expires stale keys when ttl is set", () => {
    const counter = createBoundedCounter({
      maxTrackedKeys: 100,
      ttlMs: 10,
      pruneIntervalMs: 10,
    });

    counter.increment("old-1", 100);
    counter.increment("old-2", 100);
    expect(counter.size()).toBe(2);

    counter.increment("fresh", 120);
    expect(counter.size()).toBe(1);
  });
});
