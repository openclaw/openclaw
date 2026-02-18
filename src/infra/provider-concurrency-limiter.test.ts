import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  providerConcurrencyLimiter,
  normalizeProviderId,
  withProviderConcurrency,
  type ProviderConcurrencyLimits,
} from "./provider-concurrency-limiter.js";

describe("ProviderConcurrencyLimiter", () => {
  beforeEach(() => {
    providerConcurrencyLimiter.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    providerConcurrencyLimiter.reset();
    vi.useRealTimers();
  });

  describe("normalizeProviderId", () => {
    it("extracts provider from model string", () => {
      expect(normalizeProviderId("llamacpp/qwen")).toBe("llamacpp");
      expect(normalizeProviderId("anthropic/claude-3")).toBe("anthropic");
      expect(normalizeProviderId("vllm/model")).toBe("vllm");
    });

    it("extracts host from baseUrl", () => {
      expect(normalizeProviderId("llamacpp/qwen", "http://localhost:8000")).toBe("localhost:8000");
      expect(normalizeProviderId("vllm/model", "http://192.168.1.100:5001/v1")).toBe(
        "192.168.1.100:5001",
      );
    });

    it("handles invalid URLs gracefully", () => {
      expect(normalizeProviderId("llamacpp/qwen", "not-a-url")).toBe("not-a-url");
    });
  });

  describe("acquire and release", () => {
    it("acquires immediately when under limit", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 2 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");
      expect(token1).toBeDefined();

      const token2 = await providerConcurrencyLimiter.acquire("test");
      expect(token2).toBeDefined();

      expect(providerConcurrencyLimiter.getStats("test").active).toBe(2);
    });

    it("queues requests when at limit", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");
      expect(providerConcurrencyLimiter.getStats("test").active).toBe(1);

      // Second request should queue
      const promise2 = providerConcurrencyLimiter.acquire("test");

      // Process next tick to ensure promise is queued
      await vi.advanceTimersByTimeAsync(0);

      expect(providerConcurrencyLimiter.getStats("test").active).toBe(1);
      expect(providerConcurrencyLimiter.getStats("test").queued).toBe(1);

      // Release first token
      providerConcurrencyLimiter.release("test", token1);

      // Second request should now acquire
      const token2 = await promise2;
      expect(token2).toBeDefined();
      expect(providerConcurrencyLimiter.getStats("test").active).toBe(1);
      expect(providerConcurrencyLimiter.getStats("test").queued).toBe(0);
    });

    it("processes queue in priority order", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");

      // Queue three requests with different priorities
      const promise1 = providerConcurrencyLimiter.acquire("test", { priority: 0 });
      const promise2 = providerConcurrencyLimiter.acquire("test", { priority: 10 }); // Highest
      const promise3 = providerConcurrencyLimiter.acquire("test", { priority: 5 });

      await vi.advanceTimersByTimeAsync(0);

      expect(providerConcurrencyLimiter.getStats("test").queued).toBe(3);

      const resolved: number[] = [];

      void promise1.then(() => resolved.push(1));
      void promise2.then(() => resolved.push(2));
      void promise3.then(() => resolved.push(3));

      // Release and let them process
      providerConcurrencyLimiter.release("test", token1);
      const token2 = await promise2; // Highest priority

      providerConcurrencyLimiter.release("test", token2);
      const token3 = await promise3; // Middle priority

      providerConcurrencyLimiter.release("test", token3);
      await promise1; // Lowest priority

      expect(resolved).toEqual([2, 3, 1]);
    });

    it("times out queued requests", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1, queueTimeoutMs: 1000 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");

      const promise2 = providerConcurrencyLimiter.acquire("test");

      // Wait for promise to be queued
      await vi.advanceTimersByTimeAsync(0);

      // Advance past timeout and wait for rejection to be handled
      const timeoutPromise = vi.advanceTimersByTimeAsync(1100);

      await expect(promise2).rejects.toThrow("timed out after 1000ms in queue");
      await timeoutPromise;

      // Queue should be empty
      expect(providerConcurrencyLimiter.getStats("test").queued).toBe(0);

      // Cleanup
      providerConcurrencyLimiter.release("test", token1);
    });

    it("handles concurrent releases correctly", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 2 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");
      const token2 = await providerConcurrencyLimiter.acquire("test");

      expect(providerConcurrencyLimiter.getStats("test").active).toBe(2);

      providerConcurrencyLimiter.release("test", token1);
      providerConcurrencyLimiter.release("test", token2);

      expect(providerConcurrencyLimiter.getStats("test").active).toBe(0);
    });
  });

  describe("withProviderConcurrency", () => {
    it("wraps function execution with concurrency limiting", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1 } },
      });

      let activeCount = 0;
      let maxActiveCount = 0;

      const fn = async () => {
        activeCount++;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 100));
        activeCount--;
        return "done";
      };

      // Start 3 concurrent calls
      const promises = [
        withProviderConcurrency("test", fn),
        withProviderConcurrency("test", fn),
        withProviderConcurrency("test", fn),
      ];

      // Process timers
      await vi.advanceTimersByTimeAsync(0);

      // Should have 1 active, 2 queued
      expect(providerConcurrencyLimiter.getStats("test").active).toBe(1);
      expect(providerConcurrencyLimiter.getStats("test").queued).toBe(2);

      // Complete all
      await vi.advanceTimersByTimeAsync(300);
      const results = await Promise.all(promises);

      expect(results).toEqual(["done", "done", "done"]);
      expect(maxActiveCount).toBe(1); // Never more than 1 concurrent
    });

    it("releases on function error", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1 } },
      });

      const error = new Error("test error");

      await expect(
        withProviderConcurrency("test", async () => {
          throw error;
        }),
      ).rejects.toThrow(error);

      // Should have released the lock
      expect(providerConcurrencyLimiter.getStats("test").active).toBe(0);
    });
  });

  describe("configuration", () => {
    it("uses provider-specific config over default", () => {
      const config: ProviderConcurrencyLimits = {
        default: { maxConcurrent: 5, queueTimeoutMs: 10000 },
        providers: {
          llamacpp: { maxConcurrent: 1, queueTimeoutMs: 5000 },
        },
      };

      providerConcurrencyLimiter.configure(config);

      const llamacppConfig = providerConcurrencyLimiter.getConfig("llamacpp");
      expect(llamacppConfig.maxConcurrent).toBe(1);
      expect(llamacppConfig.queueTimeoutMs).toBe(5000);

      const otherConfig = providerConcurrencyLimiter.getConfig("anthropic");
      expect(otherConfig.maxConcurrent).toBe(5);
      expect(otherConfig.queueTimeoutMs).toBe(10000);
    });

    it("falls back to infinity when no config provided", () => {
      providerConcurrencyLimiter.configure({});

      const config = providerConcurrencyLimiter.getConfig("unconfigured");
      expect(config.maxConcurrent).toBe(Infinity);
      expect(config.queueTimeoutMs).toBe(30000);
    });
  });

  describe("stats", () => {
    it("tracks queue and active counts", async () => {
      providerConcurrencyLimiter.configure({
        providers: { test: { maxConcurrent: 1 } },
      });

      const token1 = await providerConcurrencyLimiter.acquire("test");
      void providerConcurrencyLimiter.acquire("test");
      void providerConcurrencyLimiter.acquire("test");

      await vi.advanceTimersByTimeAsync(0);

      const stats = providerConcurrencyLimiter.getStats("test");
      expect(stats.active).toBe(1);
      expect(stats.queued).toBe(2);
      expect(stats.requestCount).toBe(3);

      providerConcurrencyLimiter.release("test", token1);
    });
  });
});
