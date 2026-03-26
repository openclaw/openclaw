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

  describe("priority triage", () => {
    it("drops LOW when bucket is empty", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 0,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.LOW); // drains to 0
      await expect(limiter.acquire(EmbeddingPriority.LOW)).rejects.toThrow(EmbeddingDroppedError);
      limiter.dispose();
    });

    it("drops MEDIUM when bucket is empty", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 0,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.HIGH); // drains to 0
      await expect(limiter.acquire(EmbeddingPriority.MEDIUM)).rejects.toThrow(
        EmbeddingDroppedError,
      );
      limiter.dispose();
    });

    it("drops MEDIUM when below cooldown threshold", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 0,
        cooldownThreshold: 50,
      });
      for (let i = 0; i < 50; i++) {
        await limiter.acquire(EmbeddingPriority.HIGH);
      }
      expect(limiter.tokens).toBe(50);
      await expect(limiter.acquire(EmbeddingPriority.MEDIUM)).rejects.toThrow(
        EmbeddingDroppedError,
      );
      limiter.dispose();
    });

    it("drops LOW when below cooldown threshold", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 0,
        cooldownThreshold: 50,
      });
      for (let i = 0; i < 50; i++) {
        await limiter.acquire(EmbeddingPriority.HIGH);
      }
      expect(limiter.tokens).toBe(50);
      await expect(limiter.acquire(EmbeddingPriority.LOW)).rejects.toThrow(EmbeddingDroppedError);
      limiter.dispose();
    });

    it("queues HIGH when bucket is empty and resolves on refill", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 60,
        refillIntervalMs: 1000,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.HIGH); // drains to 0
      const promise = limiter.acquire(EmbeddingPriority.HIGH); // queued
      vi.advanceTimersByTime(1000);
      await promise; // should resolve
      limiter.dispose();
    });

    it("allows HIGH when bucket has tokens even below threshold", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 0,
        cooldownThreshold: 50,
      });
      for (let i = 0; i < 70; i++) {
        await limiter.acquire(EmbeddingPriority.HIGH);
      }
      expect(limiter.tokens).toBe(30);
      await limiter.acquire(EmbeddingPriority.HIGH);
      expect(limiter.tokens).toBe(29);
      limiter.dispose();
    });
  });

  describe("queue constraints", () => {
    it("drops HIGH when queue is full", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 0,
        maxQueueSize: 2,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.HIGH); // drains to 0
      const p1 = limiter.acquire(EmbeddingPriority.HIGH);
      const p2 = limiter.acquire(EmbeddingPriority.HIGH);
      await expect(limiter.acquire(EmbeddingPriority.HIGH)).rejects.toThrow(EmbeddingDroppedError);
      limiter.dispose();
      await Promise.allSettled([p1, p2]);
    });

    it("rejects queued entry on timeout", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority, EmbeddingDroppedError } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 0,
        queueTimeoutMs: 5000,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.HIGH); // drains to 0
      const promise = limiter.acquire(EmbeddingPriority.HIGH); // queued
      vi.advanceTimersByTime(5000);
      await expect(promise).rejects.toThrow(EmbeddingDroppedError);
      limiter.dispose();
    });

    it("resolves queued entries in FIFO order", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 1,
        refillRate: 60,
        refillIntervalMs: 1000,
        maxQueueSize: 10,
        cooldownThreshold: 0,
      });
      await limiter.acquire(EmbeddingPriority.HIGH); // drains to 0
      const order: number[] = [];
      const p1 = limiter.acquire(EmbeddingPriority.HIGH).then(() => order.push(1));
      const p2 = limiter.acquire(EmbeddingPriority.HIGH).then(() => order.push(2));
      vi.advanceTimersByTime(1000);
      await p1;
      vi.advanceTimersByTime(1000);
      await p2;
      expect(order).toEqual([1, 2]);
      limiter.dispose();
    });
  });

  describe("429 feedback", () => {
    it("drains bucket and pauses refill on reportThrottled", async () => {
      const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 600,
        refillIntervalMs: 1000,
      });
      for (let i = 0; i < 50; i++) {
        await limiter.acquire(EmbeddingPriority.HIGH);
      }
      expect(limiter.tokens).toBe(50);
      limiter.reportThrottled(5);
      expect(limiter.tokens).toBe(0);
      vi.advanceTimersByTime(3000);
      expect(limiter.tokens).toBe(0);
      vi.advanceTimersByTime(3000);
      expect(limiter.tokens).toBeGreaterThan(0);
      limiter.dispose();
    });

    it("uses default 60s penalty when retryAfterSeconds is undefined", async () => {
      const { GeminiEmbeddingRateLimiter } = await import("./embedding-rate-limiter.js");
      const limiter = new GeminiEmbeddingRateLimiter({
        capacity: 100,
        refillRate: 600,
        refillIntervalMs: 1000,
      });
      limiter.reportThrottled();
      expect(limiter.tokens).toBe(0);
      vi.advanceTimersByTime(59_000);
      expect(limiter.tokens).toBe(0);
      vi.advanceTimersByTime(2000);
      expect(limiter.tokens).toBeGreaterThan(0);
      limiter.dispose();
    });
  });

  describe("singleton registry", () => {
    it("returns same limiter for same key", async () => {
      const { getOrCreateLimiter, disposeAllLimiters } =
        await import("./embedding-rate-limiter.js");
      const a = getOrCreateLimiter("key-abc");
      const b = getOrCreateLimiter("key-abc");
      expect(a).toBe(b);
      disposeAllLimiters();
    });

    it("returns different limiters for different keys", async () => {
      const { getOrCreateLimiter, disposeAllLimiters } =
        await import("./embedding-rate-limiter.js");
      const a = getOrCreateLimiter("key-1");
      const b = getOrCreateLimiter("key-2");
      expect(a).not.toBe(b);
      disposeAllLimiters();
    });
  });

  describe("reasonToPriority", () => {
    it("maps sync reasons to correct priorities", async () => {
      const { reasonToPriority, EmbeddingPriority } = await import("./embedding-rate-limiter.js");
      expect(reasonToPriority("search")).toBe(EmbeddingPriority.HIGH);
      expect(reasonToPriority("fallback")).toBe(EmbeddingPriority.HIGH);
      expect(reasonToPriority("session-delta")).toBe(EmbeddingPriority.MEDIUM);
      expect(reasonToPriority("session-start")).toBe(EmbeddingPriority.LOW);
      expect(reasonToPriority("watch")).toBe(EmbeddingPriority.LOW);
      expect(reasonToPriority("interval")).toBe(EmbeddingPriority.LOW);
      expect(reasonToPriority(undefined)).toBe(EmbeddingPriority.LOW);
      expect(reasonToPriority("something-else")).toBe(EmbeddingPriority.LOW);
    });
  });

  describe("test mode bypass", () => {
    it("bypasses all limiting when OPENCLAW_TEST_FAST=1", async () => {
      vi.stubEnv("OPENCLAW_TEST_FAST", "1");
      try {
        const { GeminiEmbeddingRateLimiter, EmbeddingPriority } =
          await import("./embedding-rate-limiter.js");
        const limiter = new GeminiEmbeddingRateLimiter({
          capacity: 1,
          refillRate: 0,
          cooldownThreshold: 0,
        });
        await limiter.acquire(EmbeddingPriority.LOW);
        await limiter.acquire(EmbeddingPriority.LOW);
        await limiter.acquire(EmbeddingPriority.LOW);
        limiter.dispose();
      } finally {
        vi.stubEnv("OPENCLAW_TEST_FAST", "");
      }
    });
  });

  describe("EmbeddingDroppedError", () => {
    it("has correct properties", async () => {
      const { EmbeddingDroppedError, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const err = new EmbeddingDroppedError({
        priority: EmbeddingPriority.LOW,
        dropReason: "bucket_empty",
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EmbeddingDroppedError);
      expect(err.name).toBe("EmbeddingDroppedError");
      expect(err.priority).toBe(EmbeddingPriority.LOW);
      expect(err.dropReason).toBe("bucket_empty");
      expect(err.message).toContain("LOW");
      expect(err.message).toContain("bucket_empty");
    });

    it("has correct properties for queue_full", async () => {
      const { EmbeddingDroppedError, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const err = new EmbeddingDroppedError({
        priority: EmbeddingPriority.HIGH,
        dropReason: "queue_full",
      });
      expect(err.dropReason).toBe("queue_full");
    });

    it("accepts custom message", async () => {
      const { EmbeddingDroppedError, EmbeddingPriority } =
        await import("./embedding-rate-limiter.js");
      const err = new EmbeddingDroppedError({
        priority: EmbeddingPriority.HIGH,
        dropReason: "queue_timeout",
        message: "custom timeout message",
      });
      expect(err.message).toBe("custom timeout message");
    });
  });
});
