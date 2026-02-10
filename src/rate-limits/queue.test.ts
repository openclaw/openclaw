import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import type { AcquireResult } from "./types.js";
import { RateLimitQueue, RateLimitQueueFullError, RateLimitQueueTimeoutError } from "./queue.js";

describe("RateLimitQueue", () => {
  let queue: RateLimitQueue;
  // Track all enqueued promises so we can suppress unhandled rejections.
  let pendingPromises: Promise<unknown>[];

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new RateLimitQueue({ maxSize: 3, timeoutMs: 5000 });
    pendingPromises = [];
  });

  afterEach(async () => {
    try {
      // Drain all pending entries before restoring timers to prevent unhandled rejections.
      queue.drainAll();
    } catch {
      // Ignore drain errors
    }
    // Suppress unhandled rejections from drained promises.
    for (const p of pendingPromises) {
      void p.catch(() => {});
    }
    pendingPromises = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Helper to enqueue and track the promise for cleanup. */
  function trackEnqueue<T>(
    key: string,
    retryAfterMs: number,
    acquireFn: () => AcquireResult,
    fn: () => Promise<T>,
  ): Promise<T> {
    const p = queue.enqueue(key, retryAfterMs, acquireFn, fn);
    pendingPromises.push(p);
    return p;
  }

  describe("enqueue", () => {
    it("queues a request and resolves when drain fires and limiter permits", async () => {
      const acquireFn = vi.fn<() => AcquireResult>().mockReturnValue({ allowed: true });
      const fn = vi.fn().mockResolvedValue("result");

      const promise = trackEnqueue("test:rpm", 1000, acquireFn, fn);

      // Advance past the retryAfterMs to trigger the drain timer.
      await vi.advanceTimersByTimeAsync(1001);

      const result = await promise;
      expect(result).toBe("result");
      expect(fn).toHaveBeenCalledOnce();
    });

    it("rejects with queue-full error when maxSize exceeded", async () => {
      const acquireFn = vi
        .fn<() => AcquireResult>()
        .mockReturnValue({ allowed: false, retryAfterMs: 60000 });
      const fn = vi.fn().mockResolvedValue("ok");

      // Fill the queue to max (3).
      trackEnqueue("test:rpm", 60000, acquireFn, fn);
      trackEnqueue("test:rpm", 60000, acquireFn, fn);
      trackEnqueue("test:rpm", 60000, acquireFn, fn);

      // 4th should be rejected immediately.
      const p4 = queue.enqueue("test:rpm", 60000, acquireFn, fn);
      pendingPromises.push(p4);
      await expect(p4).rejects.toThrow(RateLimitQueueFullError);
    });

    it("rejects entries that time out in the queue", async () => {
      const acquireFn = vi
        .fn<() => AcquireResult>()
        .mockReturnValue({ allowed: false, retryAfterMs: 1000 });
      const fn = vi.fn().mockResolvedValue("result");

      const promise = trackEnqueue("test:rpm", 1000, acquireFn, fn);

      // Attach the rejection expectation BEFORE advancing timers,
      // so the handler is registered before the drain fires.
      const assertion = expect(promise).rejects.toThrow(RateLimitQueueTimeoutError);

      // Advance time past the queue timeout (5000ms) + drain cycles.
      await vi.advanceTimersByTimeAsync(6000);

      await assertion;
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("getQueueDepth", () => {
    it("tracks queue depth correctly", () => {
      expect(queue.getQueueDepth("test:rpm")).toBe(0);

      const acquireFn = vi
        .fn<() => AcquireResult>()
        .mockReturnValue({ allowed: false, retryAfterMs: 60000 });
      const fn = vi.fn().mockResolvedValue("ok");

      trackEnqueue("test:rpm", 60000, acquireFn, fn);
      expect(queue.getQueueDepth("test:rpm")).toBe(1);

      trackEnqueue("test:rpm", 60000, acquireFn, fn);
      expect(queue.getQueueDepth("test:rpm")).toBe(2);
    });
  });

  describe("getTotalDepth", () => {
    it("returns total across all keys", () => {
      const acquireFn = vi
        .fn<() => AcquireResult>()
        .mockReturnValue({ allowed: false, retryAfterMs: 60000 });
      const fn = vi.fn().mockResolvedValue("ok");

      trackEnqueue("a:rpm", 60000, acquireFn, fn);
      trackEnqueue("b:rpm", 60000, acquireFn, fn);

      expect(queue.getTotalDepth()).toBe(2);
    });
  });

  describe("drainAll", () => {
    it("rejects all pending entries and clears queue", async () => {
      const acquireFn = vi
        .fn<() => AcquireResult>()
        .mockReturnValue({ allowed: false, retryAfterMs: 60000 });
      const fn = vi.fn().mockResolvedValue("ok");

      const p1 = trackEnqueue("test:rpm", 60000, acquireFn, fn);
      const p2 = trackEnqueue("test:rpm", 60000, acquireFn, fn);

      queue.drainAll();

      await expect(p1).rejects.toThrow();
      await expect(p2).rejects.toThrow();
      expect(queue.getQueueDepth("test:rpm")).toBe(0);
    });
  });
});
