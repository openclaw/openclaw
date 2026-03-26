import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("GeminiEmbeddingRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_TEST_FAST", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("token bucket", () => {
    it("allows requests when bucket has tokens", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 10,
        refillRate: 10,
        cooldownThreshold: 0,
      });
      // Should not throw
      await limiter.acquire(EmbeddingPriority.LOW);
      expect(limiter.tokens).toBe(9);
      limiter.dispose();
    });

    it("drains tokens on each acquire", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 3,
        refillRate: 3,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.LOW);
      await limiter.acquire(EmbeddingPriority.LOW);
      await limiter.acquire(EmbeddingPriority.LOW);
      expect(limiter.tokens).toBe(0);
      limiter.dispose();
    });

    it("refills tokens over time", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 60,
        refillIntervalMs: 1000,
      });
      // Drain all
      for (let i = 0; i < 100; i++) {
        await limiter.acquire(EmbeddingPriority.HIGH);
      }
      expect(limiter.tokens).toBe(0);
      // Advance 1 second — should refill 1 token (60 per minute = 1 per second)
      vi.advanceTimersByTime(1000);
      expect(limiter.tokens).toBe(1);
      limiter.dispose();
    });

    it("does not refill above capacity", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 10,
        refillRate: 600,
        refillIntervalMs: 1000,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.LOW);
      expect(limiter.tokens).toBe(9);
      // Advance 1 second — would add 10, but capped at capacity
      vi.advanceTimersByTime(1000);
      expect(limiter.tokens).toBe(10);
      limiter.dispose();
    });
  });
});
