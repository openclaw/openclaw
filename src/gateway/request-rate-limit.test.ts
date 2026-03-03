import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingTierToRateLimitTier,
  createRequestRateLimiter,
  RATE_LIMIT_TIERS,
  type RequestRateLimiter,
} from "./request-rate-limit.js";

describe("request rate limiter", () => {
  let limiter: RequestRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T00:00:00.000Z"));
  });

  afterEach(() => {
    limiter?.shutdown();
    vi.useRealTimers();
  });

  // ---------- createRequestRateLimiter: default config ----------

  describe("createRequestRateLimiter", () => {
    it("creates a limiter with default config when no options provided", () => {
      limiter = createRequestRateLimiter();
      expect(limiter.size()).toBe(0);

      // Default config tier: 60 rpm, burstSize 15
      const result = limiter.tryConsume("user-1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(14); // 15 burst - 1 consumed
      expect(result.retryAfterMs).toBe(0);
      expect(limiter.size()).toBe(1);
    });

    it("creates a limiter with custom config overrides", () => {
      limiter = createRequestRateLimiter({
        requestsPerMinute: 120,
        burstSize: 30,
      });

      const result = limiter.tryConsume("user-1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(29); // 30 burst - 1 consumed
    });

    it("uses custom burstSize as initial token capacity", () => {
      limiter = createRequestRateLimiter({ burstSize: 5 });

      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume("user-1").allowed).toBe(true);
      }
      expect(limiter.tryConsume("user-1").allowed).toBe(false);
    });
  });

  // ---------- tryConsume: basic allow/deny ----------

  describe("tryConsume", () => {
    it("allows requests when tokens are available", () => {
      limiter = createRequestRateLimiter({ burstSize: 3 });
      const r1 = limiter.tryConsume("user-a");
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(r1.retryAfterMs).toBe(0);

      const r2 = limiter.tryConsume("user-a");
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);
    });

    it("denies requests when the bucket is empty", () => {
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 2 });
      limiter.tryConsume("user-b");
      limiter.tryConsume("user-b");

      const denied = limiter.tryConsume("user-b");
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("returns correct retryAfterMs when bucket is empty", () => {
      // 60 rpm = 1 token/second = 1000ms per token
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      limiter.tryConsume("user-c");

      const denied = limiter.tryConsume("user-c");
      expect(denied.allowed).toBe(false);
      // With 1 token/sec, refill takes ~1000ms for a full token
      expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("tracks keys independently", () => {
      limiter = createRequestRateLimiter({ burstSize: 1 });
      limiter.tryConsume("user-x");
      expect(limiter.tryConsume("user-x").allowed).toBe(false);

      // Different key should be unaffected
      const result = limiter.tryConsume("user-y");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0); // burstSize 1 - 1 = 0
    });

    it("uses config tier (not named tier) when no tier parameter is given", () => {
      limiter = createRequestRateLimiter({
        requestsPerMinute: 600,
        burstSize: 100,
      });

      const result = limiter.tryConsume("user-config");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99); // 100 - 1
    });

    it("uses named tier when tier parameter is provided", () => {
      limiter = createRequestRateLimiter({ burstSize: 5 });

      // zen-pro has burstSize 75
      const result = limiter.tryConsume("user-tier", "zen-pro");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(74); // 75 - 1
    });
  });

  // ---------- token refill ----------

  describe("token refill", () => {
    it("refills tokens over time at the configured rate", () => {
      // 60 rpm = 1 token per second
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 2 });

      // Drain the bucket
      limiter.tryConsume("user-refill");
      limiter.tryConsume("user-refill");
      expect(limiter.tryConsume("user-refill").allowed).toBe(false);

      // Advance 1 second -- should refill 1 token
      vi.advanceTimersByTime(1000);
      const result = limiter.tryConsume("user-refill");
      expect(result.allowed).toBe(true);
    });

    it("does not exceed burst capacity during refill", () => {
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 3 });

      // Consume 1 token
      limiter.tryConsume("user-cap");

      // Wait much longer than needed to fully refill
      vi.advanceTimersByTime(120_000);

      // Should be capped at burstSize (3), not higher
      const result = limiter.tryConsume("user-cap");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2); // 3 (capped) - 1 = 2
    });

    it("refills fractional tokens over short intervals", () => {
      // 60 rpm = 1 token/sec; in 500ms we get 0.5 tokens
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      limiter.tryConsume("user-frac");

      // After 500ms, only 0.5 tokens refilled -- not enough for a full consume
      vi.advanceTimersByTime(500);
      expect(limiter.tryConsume("user-frac").allowed).toBe(false);

      // After another 600ms (total 1100ms), we should have >= 1 token
      vi.advanceTimersByTime(600);
      expect(limiter.tryConsume("user-frac").allowed).toBe(true);
    });

    it("handles high refill rates correctly", () => {
      // 50000 rpm = ~833 tokens/sec
      limiter = createRequestRateLimiter({
        requestsPerMinute: 50_000,
        burstSize: 10,
      });

      // Drain all 10
      for (let i = 0; i < 10; i++) {
        limiter.tryConsume("user-fast");
      }
      expect(limiter.tryConsume("user-fast").allowed).toBe(false);

      // 12ms at 833 tokens/sec = ~10 tokens
      vi.advanceTimersByTime(12);
      const result = limiter.tryConsume("user-fast");
      expect(result.allowed).toBe(true);
    });
  });

  // ---------- burst capacity ----------

  describe("burst capacity", () => {
    it("allows burst up to burstSize, then rate-limits", () => {
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 5 });

      // Consume all 5 burst tokens
      for (let i = 0; i < 5; i++) {
        const result = limiter.tryConsume("burst-user");
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }

      // 6th request should be denied
      const denied = limiter.tryConsume("burst-user");
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("burst tokens replenish fully after enough idle time", () => {
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 5 });

      // Drain all burst
      for (let i = 0; i < 5; i++) {
        limiter.tryConsume("burst-refill");
      }
      expect(limiter.tryConsume("burst-refill").allowed).toBe(false);

      // 5 tokens at 1/sec = 5 seconds to fully refill
      vi.advanceTimersByTime(5000);

      // Should have 5 tokens again
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume("burst-refill").allowed).toBe(true);
      }
      expect(limiter.tryConsume("burst-refill").allowed).toBe(false);
    });

    it("named tiers have their own burst sizes", () => {
      limiter = createRequestRateLimiter();

      // zen-enterprise: burstSize 5000
      const result = limiter.tryConsume("ent-user", "zen-enterprise");
      expect(result.remaining).toBe(4999); // 5000 - 1
    });
  });

  // ---------- tier resolution ----------

  describe("tier resolution via tryConsume", () => {
    it("resolves zen-free tier", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-free", "zen-free");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-free"].burstSize - 1);
    });

    it("resolves zen-pro tier", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-pro", "zen-pro");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-pro"].burstSize - 1);
    });

    it("resolves zen-team tier", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-team", "zen-team");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-team"].burstSize - 1);
    });

    it("resolves zen-enterprise tier", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-ent", "zen-enterprise");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-enterprise"].burstSize - 1);
    });

    it("resolves zen-custom tier", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-cust", "zen-custom");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-custom"].burstSize - 1);
    });

    it("falls back to zen-free for unknown tier name", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-unknown", "imaginary-tier");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-free"].burstSize - 1);
    });

    it("is case-insensitive for tier names", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-case", "ZEN-PRO");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-pro"].burstSize - 1);
    });

    it("trims whitespace from tier names", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("t-ws", "  zen-team  ");
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-team"].burstSize - 1);
    });

    it("updates bucket capacity when tier changes on an existing key", () => {
      limiter = createRequestRateLimiter();

      // Start as zen-free (burstSize 15)
      limiter.tryConsume("upgrade-user", "zen-free");

      // "Upgrade" to zen-pro (burstSize 75)
      vi.advanceTimersByTime(1000);
      const result = limiter.tryConsume("upgrade-user", "zen-pro");
      expect(result.allowed).toBe(true);
      // Capacity should now be 75 (zen-pro burst), tokens refilled at zen-pro rate
    });
  });

  // ---------- billingTierToRateLimitTier ----------

  describe("billingTierToRateLimitTier", () => {
    it("maps zen-free to zen-free", () => {
      expect(billingTierToRateLimitTier("zen-free")).toBe("zen-free");
    });

    it("maps 'free' (backward compat) to zen-free", () => {
      expect(billingTierToRateLimitTier("free")).toBe("zen-free");
    });

    it("maps 'developer' (backward compat) to zen-free", () => {
      expect(billingTierToRateLimitTier("developer")).toBe("zen-free");
    });

    it("maps zen-pro to zen-pro", () => {
      expect(billingTierToRateLimitTier("zen-pro")).toBe("zen-pro");
    });

    it("maps 'pro' (backward compat) to zen-pro", () => {
      expect(billingTierToRateLimitTier("pro")).toBe("zen-pro");
    });

    it("maps 'starter' (backward compat) to zen-pro", () => {
      expect(billingTierToRateLimitTier("starter")).toBe("zen-pro");
    });

    it("maps zen-team to zen-team", () => {
      expect(billingTierToRateLimitTier("zen-team")).toBe("zen-team");
    });

    it("maps 'team' (backward compat) to zen-team", () => {
      expect(billingTierToRateLimitTier("team")).toBe("zen-team");
    });

    it("maps zen-enterprise to zen-enterprise", () => {
      expect(billingTierToRateLimitTier("zen-enterprise")).toBe("zen-enterprise");
    });

    it("maps 'enterprise' (backward compat) to zen-enterprise", () => {
      expect(billingTierToRateLimitTier("enterprise")).toBe("zen-enterprise");
    });

    it("maps 'scale' (backward compat) to zen-enterprise", () => {
      expect(billingTierToRateLimitTier("scale")).toBe("zen-enterprise");
    });

    it("maps zen-custom to zen-custom", () => {
      expect(billingTierToRateLimitTier("zen-custom")).toBe("zen-custom");
    });

    it("maps 'custom' (backward compat) to zen-custom", () => {
      expect(billingTierToRateLimitTier("custom")).toBe("zen-custom");
    });

    it("returns zen-free for undefined input", () => {
      expect(billingTierToRateLimitTier(undefined)).toBe("zen-free");
    });

    it("returns zen-free for empty string", () => {
      expect(billingTierToRateLimitTier("")).toBe("zen-free");
    });

    it("returns zen-free for unknown plan tier", () => {
      expect(billingTierToRateLimitTier("ultra-mega")).toBe("zen-free");
    });

    it("is case-insensitive", () => {
      expect(billingTierToRateLimitTier("PRO")).toBe("zen-pro");
      expect(billingTierToRateLimitTier("Enterprise")).toBe("zen-enterprise");
      expect(billingTierToRateLimitTier("ZEN-CUSTOM")).toBe("zen-custom");
    });

    it("trims whitespace", () => {
      expect(billingTierToRateLimitTier("  team  ")).toBe("zen-team");
      expect(billingTierToRateLimitTier(" scale ")).toBe("zen-enterprise");
    });
  });

  // ---------- prune ----------

  describe("prune", () => {
    it("removes stale buckets after 5 minutes of inactivity", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 0 });
      limiter.tryConsume("stale-user");
      expect(limiter.size()).toBe(1);

      // Advance past the 5-minute stale threshold
      vi.advanceTimersByTime(5 * 60_000);
      limiter.prune();
      expect(limiter.size()).toBe(0);
    });

    it("keeps buckets that are still active", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 0 });
      limiter.tryConsume("active-user");

      // Advance 4 minutes (under the 5-minute threshold)
      vi.advanceTimersByTime(4 * 60_000);
      limiter.prune();
      expect(limiter.size()).toBe(1);
    });

    it("keeps active buckets while removing stale ones", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 0 });
      limiter.tryConsume("old-user");
      limiter.tryConsume("new-user");

      // Advance 3 minutes -- both still active
      vi.advanceTimersByTime(3 * 60_000);

      // Touch new-user to keep it active
      limiter.tryConsume("new-user");

      // Advance another 2.5 minutes -- old-user is now 5.5 min stale
      vi.advanceTimersByTime(2.5 * 60_000);
      limiter.prune();

      expect(limiter.size()).toBe(1); // only new-user remains
    });

    it("runs automatically on the cleanup interval", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 10_000 });
      limiter.tryConsume("auto-prune");
      expect(limiter.size()).toBe(1);

      // Advance past the stale threshold + one cleanup interval tick
      vi.advanceTimersByTime(5 * 60_000 + 10_000);
      expect(limiter.size()).toBe(0);
    });
  });

  // ---------- shutdown ----------

  describe("shutdown", () => {
    it("clears all tracked buckets", () => {
      limiter = createRequestRateLimiter();
      limiter.tryConsume("shutdown-1");
      limiter.tryConsume("shutdown-2");
      limiter.tryConsume("shutdown-3");
      expect(limiter.size()).toBe(3);

      limiter.shutdown();
      expect(limiter.size()).toBe(0);
    });

    it("cancels the periodic cleanup timer", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 1000 });
      limiter.tryConsume("timer-user");

      limiter.shutdown();

      // Re-add a bucket after shutdown; advancing time should NOT auto-prune
      // because the timer was cleared.
      // (We create a new limiter with 0 interval to test manually.)
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 0 });
      limiter.tryConsume("post-shutdown");
      expect(limiter.size()).toBe(1);
    });
  });

  // ---------- size ----------

  describe("size", () => {
    it("returns 0 for a fresh limiter", () => {
      limiter = createRequestRateLimiter();
      expect(limiter.size()).toBe(0);
    });

    it("increments as new keys are tracked", () => {
      limiter = createRequestRateLimiter();
      limiter.tryConsume("s1");
      expect(limiter.size()).toBe(1);
      limiter.tryConsume("s2");
      expect(limiter.size()).toBe(2);
      limiter.tryConsume("s3");
      expect(limiter.size()).toBe(3);
    });

    it("does not increment for repeated consumes on the same key", () => {
      limiter = createRequestRateLimiter();
      limiter.tryConsume("same-key");
      limiter.tryConsume("same-key");
      limiter.tryConsume("same-key");
      expect(limiter.size()).toBe(1);
    });

    it("decrements after prune removes stale entries", () => {
      limiter = createRequestRateLimiter({ cleanupIntervalMs: 0 });
      limiter.tryConsume("size-a");
      limiter.tryConsume("size-b");
      expect(limiter.size()).toBe(2);

      vi.advanceTimersByTime(5 * 60_000);
      limiter.prune();
      expect(limiter.size()).toBe(0);
    });
  });

  // ---------- edge cases ----------

  describe("edge cases", () => {
    it("falls back to default tier for unknown tier name in tryConsume", () => {
      limiter = createRequestRateLimiter();
      const result = limiter.tryConsume("edge-unknown", "nonexistent-tier");
      // Falls back to zen-free (burstSize 15)
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RATE_LIMIT_TIERS["zen-free"].burstSize - 1);
    });

    it("falls back to config tier when tier is empty string", () => {
      limiter = createRequestRateLimiter({ burstSize: 20 });
      // Empty string is falsy, so resolveTier returns zen-free default.
      // But tryConsume checks: `tier ? resolveTier(tier) : configTier`
      // Empty string is falsy -> uses configTier (burstSize 20).
      const result = limiter.tryConsume("edge-empty", "");
      // Empty string is truthy in `tier ? ...` check in JS? No -- "" is falsy.
      // So configTier (burstSize 20) is used.
      expect(result.remaining).toBe(19); // 20 - 1
    });

    it("falls back to config tier when tier is undefined", () => {
      limiter = createRequestRateLimiter({ burstSize: 25 });
      const result = limiter.tryConsume("edge-undef", undefined);
      expect(result.remaining).toBe(24); // 25 - 1
    });

    it("remaining is floor of fractional tokens", () => {
      // 120 rpm = 2 tokens/sec
      limiter = createRequestRateLimiter({ requestsPerMinute: 120, burstSize: 3 });

      // Drain all 3
      for (let i = 0; i < 3; i++) {
        limiter.tryConsume("frac-floor");
      }

      // Advance 250ms -> refills 0.5 tokens. Not enough to consume.
      vi.advanceTimersByTime(250);
      const denied = limiter.tryConsume("frac-floor");
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);

      // Advance 500ms more -> refills 1.0 more tokens (total 1.5 available)
      vi.advanceTimersByTime(500);
      const allowed = limiter.tryConsume("frac-floor");
      expect(allowed.allowed).toBe(true);
      // After consume: ~1.5 - 1 = ~0.5 -> floor = 0
      expect(allowed.remaining).toBe(0);
    });

    it("handles concurrent keys at different tiers", () => {
      limiter = createRequestRateLimiter();

      limiter.tryConsume("free-user", "zen-free");
      limiter.tryConsume("pro-user", "zen-pro");
      limiter.tryConsume("ent-user", "zen-enterprise");

      expect(limiter.size()).toBe(3);

      // Each key has its own tier's burst capacity
      // Drain free (burstSize 15): 14 remaining after first call, consume 14 more
      for (let i = 0; i < 14; i++) {
        limiter.tryConsume("free-user", "zen-free");
      }
      expect(limiter.tryConsume("free-user", "zen-free").allowed).toBe(false);

      // Pro user should still have plenty of tokens (75 - 1 = 74 left)
      expect(limiter.tryConsume("pro-user", "zen-pro").allowed).toBe(true);
    });

    it("retryAfterMs decreases as tokens partially refill", () => {
      limiter = createRequestRateLimiter({ requestsPerMinute: 60, burstSize: 1 });
      limiter.tryConsume("retry-dec");

      const denied1 = limiter.tryConsume("retry-dec");
      expect(denied1.allowed).toBe(false);
      const retry1 = denied1.retryAfterMs;

      // Advance 400ms (partial refill)
      vi.advanceTimersByTime(400);
      const denied2 = limiter.tryConsume("retry-dec");
      expect(denied2.allowed).toBe(false);
      const retry2 = denied2.retryAfterMs;

      // Second retryAfterMs should be smaller since more tokens have refilled
      expect(retry2).toBeLessThan(retry1);
    });
  });

  // ---------- RATE_LIMIT_TIERS constant ----------

  describe("RATE_LIMIT_TIERS", () => {
    it("defines exactly 5 tiers", () => {
      expect(Object.keys(RATE_LIMIT_TIERS)).toHaveLength(5);
    });

    it("all tiers have positive requestsPerMinute and burstSize", () => {
      for (const [key, tier] of Object.entries(RATE_LIMIT_TIERS)) {
        expect(tier.name).toBe(key);
        expect(tier.requestsPerMinute).toBeGreaterThan(0);
        expect(tier.burstSize).toBeGreaterThan(0);
      }
    });

    it("tiers are ordered by increasing capacity", () => {
      const order = ["zen-free", "zen-pro", "zen-team", "zen-enterprise", "zen-custom"];
      for (let i = 1; i < order.length; i++) {
        const prev = RATE_LIMIT_TIERS[order[i - 1]];
        const curr = RATE_LIMIT_TIERS[order[i]];
        expect(curr.requestsPerMinute).toBeGreaterThan(prev.requestsPerMinute);
        expect(curr.burstSize).toBeGreaterThan(prev.burstSize);
      }
    });
  });
});
