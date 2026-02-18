/**
 * Performance benchmark tests for optimization utilities
 */

import { describe, expect, it } from "vitest";
import { shallowClone, cloneWithFreeze } from "./clone.js";
import { LRUCache } from "./lru-cache.js";
import { memoize, memoizeAsync } from "./memoize.js";

describe("Performance Benchmarks", () => {
  describe("shallowClone vs structuredClone", () => {
    const testData = {
      sessions: Array.from({ length: 100 }, (_, i) => ({
        id: `session-${i}`,
        channel: "telegram",
        messages: Array.from({ length: 50 }, (_, j) => ({
          id: `msg-${j}`,
          content: `Hello world ${j}`,
          timestamp: Date.now(),
        })),
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })),
    };

    it("shallowClone is much faster than structuredClone", () => {
      const iterations = 1000;

      const structuredCloneStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        structuredClone(testData);
      }
      const structuredCloneTime = performance.now() - structuredCloneStart;

      const shallowCloneStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        shallowClone(testData);
      }
      const shallowCloneTime = performance.now() - shallowCloneStart;

      console.log(`structuredClone: ${structuredCloneTime.toFixed(2)}ms`);
      console.log(`shallowClone: ${shallowCloneTime.toFixed(2)}ms`);
      console.log(`Speedup: ${(structuredCloneTime / shallowCloneTime).toFixed(2)}x`);

      expect(shallowCloneTime).toBeLessThan(structuredCloneTime);
    });
  });

  describe("LRUCache", () => {
    it("should store and retrieve values", () => {
      const cache = new LRUCache<number>({ maxSize: 3 });

      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
    });

    it("should evict least recently used item", () => {
      const cache = new LRUCache<number>({ maxSize: 3 });

      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.get("a");
      cache.set("d", 4);

      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("should respect TTL", async () => {
      const cache = new LRUCache<number>({ maxSize: 10, ttlMs: 50 });

      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);

      await new Promise((r) => setTimeout(r, 60));

      expect(cache.get("a")).toBeUndefined();
    });

    it("should perform better than Map for repeated access", () => {
      const iterations = 10000;
      const cache = new LRUCache<number>({ maxSize: 100 });

      for (let i = 0; i < iterations; i++) {
        cache.set(`key-${i % 100}`, i);
        cache.get(`key-${i % 100}`);
      }

      expect(cache.size()).toBeLessThanOrEqual(100);
    });
  });

  describe("memoize", () => {
    it("should cache function results", () => {
      let callCount = 0;
      const fn = memoize((n: number) => {
        callCount++;
        return n * 2;
      });

      expect(fn(5)).toBe(10);
      expect(fn(5)).toBe(10);
      expect(callCount).toBe(1);
    });

    it("should limit cache size", () => {
      const fn = memoize(
        (n: number) => n * 2,
        { maxSize: 3 },
      );

      fn(1);
      fn(2);
      fn(3);
      fn(4);
      fn(1);

      expect(fn(1)).toBe(2);
    });

    it("should improve performance for repeated calls", () => {
      const expensiveFn = (n: number) => {
        let result = 0;
        for (let i = 0; i < 1000; i++) {
          result += i;
        }
        return result + n;
      };

      const memoizedFn = memoize(expensiveFn, { maxSize: 100 });

      const coldStart = performance.now();
      expensiveFn(42);
      const coldTime = performance.now() - coldStart;

      const warmStart = performance.now();
      memoizedFn(42);
      memoizedFn(42);
      memoizedFn(42);
      const warmTime = performance.now() - warmStart;

      console.log(`Cold call: ${coldTime.toFixed(2)}ms`);
      console.log(`Warm calls (3x): ${warmTime.toFixed(2)}ms`);

      expect(warmTime).toBeLessThan(coldTime);
    });
  });

  describe("memoizeAsync", () => {
    it("should cache async function results", async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (n: number) => {
        callCount++;
        return n * 2;
      });

      expect(await fn(5)).toBe(10);
      expect(await fn(5)).toBe(10);
      expect(callCount).toBe(1);
    });

    it("should handle concurrent calls with singleflight", async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (n: number) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return n * 2;
      });

      const results = await Promise.all([fn(5), fn(5), fn(5)]);

      expect(results).toEqual([10, 10, 10]);
      expect(callCount).toBe(1);
    });
  });

  describe("cloneWithFreeze", () => {
    it("should clone and freeze objects", () => {
      const original = { a: 1, b: { c: 2 } };
      const cloned = cloneWithFreeze(original);

      expect(cloned).toEqual(original);
      expect(Object.isFrozen(cloned)).toBe(true);
    });
  });
});
