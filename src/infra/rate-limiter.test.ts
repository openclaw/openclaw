import { afterEach, describe, expect, it } from "vitest";
import { type RateLimitsConfig, resolveRateLimitsConfig } from "../config/types.gateway.js";
import { RateLimiter } from "./rate-limiter.js";

// Helper: create a limiter with simple 10 tokens / 1 token per 1 000 ms config.
function makeLimiter(
  overrides?: Partial<{ maxTokens: number; refillRate: number; refillIntervalMs: number }>,
) {
  return new RateLimiter({
    maxTokens: overrides?.maxTokens ?? 10,
    refillRate: overrides?.refillRate ?? 1,
    refillIntervalMs: overrides?.refillIntervalMs ?? 1000,
  });
}

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it("allows requests within capacity", () => {
    limiter = makeLimiter({ maxTokens: 5 });
    const result = limiter.check("ip1", 0);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("denies requests when bucket is empty", () => {
    limiter = makeLimiter({ maxTokens: 2 });
    limiter.check("ip1", 0);
    limiter.check("ip1", 0);
    const result = limiter.check("ip1", 0);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("returns correct retryAfterMs when denied", () => {
    limiter = makeLimiter({ maxTokens: 1, refillRate: 1, refillIntervalMs: 500 });
    limiter.check("ip1", 0); // consume the only token
    const denied = limiter.check("ip1", 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it("returns correct remaining count", () => {
    limiter = makeLimiter({ maxTokens: 5 });
    expect(limiter.check("ip1", 0).remaining).toBe(4);
    expect(limiter.check("ip1", 0).remaining).toBe(3);
    expect(limiter.check("ip1", 0).remaining).toBe(2);
    expect(limiter.check("ip1", 0).remaining).toBe(1);
    expect(limiter.check("ip1", 0).remaining).toBe(0);
  });

  it("refills tokens after interval elapses", () => {
    limiter = makeLimiter({ maxTokens: 2, refillRate: 1, refillIntervalMs: 1000 });
    limiter.check("ip1", 0);
    limiter.check("ip1", 0);
    // Bucket empty at t=0
    expect(limiter.check("ip1", 0).allowed).toBe(false);
    // After 1 second, 1 token refilled
    const result = limiter.check("ip1", 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("does not exceed maxTokens on refill", () => {
    limiter = makeLimiter({ maxTokens: 3, refillRate: 10, refillIntervalMs: 100 });
    // consume one token
    limiter.check("ip1", 0);
    // Wait a long time — refill should cap at maxTokens
    const result = limiter.check("ip1", 100_000);
    expect(result.allowed).toBe(true);
    // remaining should be maxTokens - 1 (we just consumed one)
    expect(result.remaining).toBe(2);
  });

  it("tracks separate buckets per key", () => {
    limiter = makeLimiter({ maxTokens: 1 });
    expect(limiter.check("ip1", 0).allowed).toBe(true);
    expect(limiter.check("ip2", 0).allowed).toBe(true);
    // ip1 should be denied, ip2 independent
    expect(limiter.check("ip1", 0).allowed).toBe(false);
    expect(limiter.check("ip2", 0).allowed).toBe(false);
  });

  it("reset() clears a specific bucket", () => {
    limiter = makeLimiter({ maxTokens: 1 });
    limiter.check("ip1", 0);
    expect(limiter.check("ip1", 0).allowed).toBe(false);
    limiter.reset("ip1");
    // After reset, bucket is gone — next check creates a fresh one
    expect(limiter.check("ip1", 0).allowed).toBe(true);
  });

  it("GC removes stale entries", () => {
    limiter = makeLimiter();
    limiter.check("old-ip", 0);
    expect(limiter.size).toBe(1);
    // 10 minutes later, the entry is stale
    limiter._gcForTest(10 * 60 * 1000);
    expect(limiter.size).toBe(0);
  });

  it("GC does not remove active entries", () => {
    limiter = makeLimiter();
    limiter.check("active-ip", 0);
    // GC at 5 minutes — entry is 5 min old, under the 10 min threshold
    limiter._gcForTest(5 * 60 * 1000);
    expect(limiter.size).toBe(1);
  });

  it("GC removes stale but keeps active", () => {
    limiter = makeLimiter();
    limiter.check("old-ip", 0);
    limiter.check("fresh-ip", 8 * 60 * 1000);
    // GC at 10 minutes: old-ip is 10 min stale, fresh-ip is 2 min stale
    limiter._gcForTest(10 * 60 * 1000);
    expect(limiter.size).toBe(1);
  });

  it("destroy() stops the GC timer", () => {
    limiter = makeLimiter();
    limiter.destroy();
    // Double destroy should be safe
    limiter.destroy();
    // After destroy, the limiter still works for check/reset, just no GC
    expect(limiter.check("ip1", 0).allowed).toBe(true);
  });

  it("handles rapid sequential calls correctly", () => {
    limiter = makeLimiter({ maxTokens: 3 });
    const r0 = limiter.check("ip1", 0);
    const r1 = limiter.check("ip1", 0);
    const r2 = limiter.check("ip1", 0);
    const r3 = limiter.check("ip1", 0);
    expect(r0.allowed).toBe(true);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r0.remaining).toBe(2);
    expect(r1.remaining).toBe(1);
    expect(r2.remaining).toBe(0);
    expect(r3.remaining).toBe(0);
  });

  it("burst: allows maxTokens requests then denies", () => {
    const max = 5;
    limiter = makeLimiter({ maxTokens: max });
    for (let i = 0; i < max; i++) {
      expect(limiter.check("burst", 0).allowed).toBe(true);
    }
    expect(limiter.check("burst", 0).allowed).toBe(false);
  });

  it("retryAfterMs accounts for partial interval progress", () => {
    limiter = makeLimiter({ maxTokens: 1, refillRate: 1, refillIntervalMs: 1000 });
    limiter.check("ip1", 0); // consume the only token at t=0

    // 700ms later — 70% through the next interval, token arrives at t=1000
    const denied = limiter.check("ip1", 700);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(300); // not 1000
  });

  it("retryAfterMs is exact when denied at interval boundary", () => {
    limiter = makeLimiter({ maxTokens: 1, refillRate: 1, refillIntervalMs: 500 });
    limiter.check("ip1", 0); // consume token at t=0

    // Denied exactly at t=0 (boundary) — should still be a full interval
    const denied = limiter.check("ip1", 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it("retryAfterMs is accurate with multi-token deficit mid-interval", () => {
    limiter = makeLimiter({ maxTokens: 2, refillRate: 1, refillIntervalMs: 500 });
    limiter.check("ip1", 0);
    limiter.check("ip1", 0); // bucket empty at t=0

    // 200ms in — need 1 token, next refill at t=500 → wait 300ms
    const denied = limiter.check("ip1", 200);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(300);
  });

  it("retryAfterMs is 1ms when token arrives in 1ms", () => {
    limiter = makeLimiter({ maxTokens: 1, refillRate: 1, refillIntervalMs: 60_000 });
    limiter.check("ip1", 0); // consume token at t=0

    // 59999ms later — 1ms away from refill
    const denied = limiter.check("ip1", 59_999);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1); // not 60000
  });

  it("partial refill across multiple intervals", () => {
    limiter = makeLimiter({ maxTokens: 10, refillRate: 2, refillIntervalMs: 500 });
    // Consume all
    for (let i = 0; i < 10; i++) {
      limiter.check("ip", 0);
    }
    expect(limiter.check("ip", 0).allowed).toBe(false);
    // 1.5 seconds later → 3 intervals × 2 = 6 tokens refilled
    const r = limiter.check("ip", 1500);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(5); // 6 refilled - 1 consumed = 5
  });
});

describe("resolveRateLimitsConfig", () => {
  it("returns defaults when called with undefined", () => {
    const resolved = resolveRateLimitsConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.http.globalPerMinute).toBe(100);
    expect(resolved.http.agentPerMinute).toBe(10);
    expect(resolved.http.hookPerMinute).toBe(20);
    expect(resolved.http.staticPerMinute).toBe(200);
    expect(resolved.ws.messagesPerMinute).toBe(60);
    expect(resolved.ws.agentPerMinute).toBe(10);
    expect(resolved.ws.ttsPerMinute).toBe(20);
    expect(resolved.ws.maxConnections).toBe(50);
    expect(resolved.ws.perIpMaxConnections).toBe(5);
    expect(resolved.auth.maxFailures).toBe(10);
    expect(resolved.auth.windowMinutes).toBe(15);
  });

  it("enabled: false disables all limiting", () => {
    const resolved = resolveRateLimitsConfig({ enabled: false });
    expect(resolved.enabled).toBe(false);
    // Defaults are still populated so consumers can check values without null checks
    expect(resolved.http.globalPerMinute).toBe(100);
  });

  it("partial config merges with defaults correctly", () => {
    const raw: RateLimitsConfig = {
      http: { globalPerMinute: 200 },
      auth: { maxFailures: 5 },
    };
    const resolved = resolveRateLimitsConfig(raw);
    expect(resolved.enabled).toBe(true);
    expect(resolved.http.globalPerMinute).toBe(200);
    expect(resolved.http.agentPerMinute).toBe(10); // default preserved
    expect(resolved.auth.maxFailures).toBe(5);
    expect(resolved.auth.windowMinutes).toBe(15); // default preserved
    expect(resolved.ws.messagesPerMinute).toBe(60); // entirely defaulted
  });

  it("returns defaults for empty object", () => {
    const resolved = resolveRateLimitsConfig({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.http.globalPerMinute).toBe(100);
  });
});
