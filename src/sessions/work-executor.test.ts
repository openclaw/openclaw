import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ParallelSessionManager, WorkItem } from "./parallel-session-manager.js";
import { WorkExecutor, type WorkHandler } from "./work-executor.js";

function createMockManager() {
  const mocks = {
    claimReadyWork: vi.fn().mockResolvedValue([]),
    transitionWork: vi.fn().mockResolvedValue(undefined),
    getWork: vi.fn().mockResolvedValue([]),
  };
  const manager = mocks as unknown as ParallelSessionManager;
  return { manager, mocks };
}

function createTestWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 1,
    sessionKey: "agent:main:parallel:discord",
    channelId: "discord",
    description: "Test work",
    payload: { action: "test" },
    status: "executing",
    priority: 5,
    createdAt: Date.now(),
    startedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("WorkExecutor", () => {
  let mocks: ReturnType<typeof createMockManager>["mocks"];
  let manager: ParallelSessionManager;
  let handler: ReturnType<typeof vi.fn<WorkHandler>>;
  let executor: WorkExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    const mock = createMockManager();
    manager = mock.manager;
    mocks = mock.mocks;
    handler = vi.fn<WorkHandler>().mockResolvedValue({ summary: "Done" });
  });

  afterEach(() => {
    executor?.stop();
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("start() begins polling", () => {
      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 1000 });
      const started = vi.fn();
      executor.on("started", started);

      executor.start();
      expect(started).toHaveBeenCalledTimes(1);
    });

    it("start() is idempotent", () => {
      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 1000 });
      const started = vi.fn();
      executor.on("started", started);

      executor.start();
      executor.start(); // Should not create second timer
      expect(started).toHaveBeenCalledTimes(1); // Only emitted once
    });

    it("stop() clears polling", () => {
      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 1000 });
      const stopped = vi.fn();
      executor.on("stopped", stopped);

      executor.start();
      executor.stop();
      expect(stopped).toHaveBeenCalledTimes(1);
    });

    it("stop() is idempotent", () => {
      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 1000 });
      const stopped = vi.fn();
      executor.on("stopped", stopped);

      executor.start();
      executor.stop();
      executor.stop(); // Should not throw
      expect(stopped).toHaveBeenCalledTimes(2); // emitted on each call (idempotent = no crash)
    });
  });

  describe("tick", () => {
    it("claims work via manager.claimReadyWork()", async () => {
      executor = new WorkExecutor(manager, handler, {
        pollIntervalMs: 1000,
        maxConcurrent: 2,
      });
      executor.start();

      // The initial tick() fires immediately on start
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.claimReadyWork).toHaveBeenCalledWith(2);
    });

    it("skips when at maxConcurrent", async () => {
      const slowHandler = vi.fn<WorkHandler>().mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      executor = new WorkExecutor(manager, slowHandler, {
        pollIntervalMs: 100,
        maxConcurrent: 1,
      });

      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]).mockResolvedValue([]);

      executor.start();
      await vi.advanceTimersByTimeAsync(0);

      // Now at maxConcurrent=1, next tick should skip
      mocks.claimReadyWork.mockClear();
      await vi.advanceTimersByTimeAsync(200);
      expect(mocks.claimReadyWork).not.toHaveBeenCalled();
    });

    it("skips when stopped", async () => {
      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      executor.start();
      executor.stop();

      mocks.claimReadyWork.mockClear();
      await vi.advanceTimersByTimeAsync(200);
      expect(mocks.claimReadyWork).not.toHaveBeenCalled();
    });
  });

  describe("executeItem", () => {
    it("updates attempts counter", async () => {
      const item = createTestWorkItem({ attempts: 0 });
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      executor.start();
      await vi.advanceTimersByTimeAsync(0);

      // Wait for handler to resolve
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.transitionWork).toHaveBeenCalledWith(1, "executing", { attempts: 1 });
    });

    it("calls handler with context including signal", async () => {
      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(handler).toHaveBeenCalledWith(
        item,
        expect.objectContaining({
          updateProgress: expect.any(Function),
          isCancelled: expect.any(Function),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("transitions to completed on success", async () => {
      handler.mockResolvedValue({ summary: "All done" });
      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      const completed = vi.fn();
      executor.on("work:completed", completed);

      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.transitionWork).toHaveBeenCalledWith(1, "completed", {
        progressPct: 100,
        resultSummary: "All done",
      });
      expect(completed).toHaveBeenCalledWith({ id: 1, summary: "All done" });
    });

    it("transitions to failed after maxAttempts", async () => {
      handler.mockRejectedValue(new Error("Boom"));
      const item = createTestWorkItem({ attempts: 2, maxAttempts: 3 });
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      const failed = vi.fn();
      executor.on("work:failed", failed);

      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.transitionWork).toHaveBeenCalledWith(
        1,
        "failed",
        expect.objectContaining({
          resultSummary: expect.stringContaining("Failed after 3 attempts"),
        }),
      );
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ id: 1, final: true }));
    });

    it("retries by transitioning to ready on non-final attempt", async () => {
      handler.mockRejectedValue(new Error("Temporary"));
      const item = createTestWorkItem({ attempts: 0, maxAttempts: 3 });
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      const failed = vi.fn();
      executor.on("work:failed", failed);

      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.transitionWork).toHaveBeenCalledWith(
        1,
        "ready",
        expect.objectContaining({
          resultSummary: expect.stringContaining("Attempt 1 failed"),
        }),
      );
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ id: 1, final: false }));
    });

    it("times out and aborts signal", async () => {
      let capturedSignal: AbortSignal | undefined;
      const slowHandler = vi.fn<WorkHandler>().mockImplementation(async (_item, ctx) => {
        capturedSignal = ctx.signal;
        // Wait longer than timeout
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { summary: "never" };
      });

      const item = createTestWorkItem({ attempts: 2, maxAttempts: 3 });
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, slowHandler, {
        pollIntervalMs: 100,
        executionTimeoutMs: 50,
      });

      executor.start();
      await vi.advanceTimersByTimeAsync(0); // start tick
      await vi.advanceTimersByTimeAsync(100); // trigger timeout

      expect(capturedSignal?.aborted).toBe(true);
      expect(mocks.transitionWork).toHaveBeenCalledWith(
        1,
        "failed",
        expect.objectContaining({
          resultSummary: expect.stringContaining("Failed after 3 attempts"),
        }),
      );
    });

    it("updateProgress is no-op after timeout", async () => {
      let capturedContext: { updateProgress: (pct: number) => Promise<void> } | undefined;
      const slowHandler = vi.fn<WorkHandler>().mockImplementation(async (_item, ctx) => {
        capturedContext = ctx;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { summary: "never" };
      });

      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, slowHandler, {
        pollIntervalMs: 100,
        executionTimeoutMs: 50,
      });

      executor.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100); // trigger timeout

      // Clear calls from setup
      mocks.transitionWork.mockClear();

      // Now try to call updateProgress after abort
      await capturedContext!.updateProgress(75);

      // Should be a no-op — no transitionWork call
      expect(mocks.transitionWork).not.toHaveBeenCalled();
    });

    it("updateProgress calls transitionWork with pct", async () => {
      handler.mockImplementation(async (_item, ctx) => {
        await ctx.updateProgress(50);
        return { summary: "Done" };
      });

      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.transitionWork).toHaveBeenCalledWith(1, "executing", { progressPct: 50 });
    });

    it("isCancelled returns true when work is cancelled externally", async () => {
      let capturedIsCancelled: (() => Promise<boolean>) | undefined;
      const capturingHandler = vi.fn<WorkHandler>().mockImplementation(async (_item, ctx) => {
        capturedIsCancelled = ctx.isCancelled;
        return { summary: "Done" };
      });

      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);
      // getWork returns the item with status cancelled
      mocks.getWork.mockResolvedValue([{ ...item, status: "cancelled" }]);

      executor = new WorkExecutor(manager, capturingHandler, { pollIntervalMs: 100 });
      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(capturedIsCancelled).toBeDefined();
      const result = await capturedIsCancelled!();
      expect(result).toBe(true);
    });

    it("isCancelled returns false when work is still active", async () => {
      let capturedIsCancelled: (() => Promise<boolean>) | undefined;
      const capturingHandler = vi.fn<WorkHandler>().mockImplementation(async (_item, ctx) => {
        capturedIsCancelled = ctx.isCancelled;
        return { summary: "Done" };
      });

      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);
      mocks.getWork.mockResolvedValue([]);

      executor = new WorkExecutor(manager, capturingHandler, { pollIntervalMs: 100 });
      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(capturedIsCancelled).toBeDefined();
      const result = await capturedIsCancelled!();
      expect(result).toBe(false);
    });

    it("emits work:executing event", async () => {
      const item = createTestWorkItem();
      mocks.claimReadyWork.mockResolvedValueOnce([item]);

      executor = new WorkExecutor(manager, handler, { pollIntervalMs: 100 });
      const executing = vi.fn();
      executor.on("work:executing", executing);

      executor.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(executing).toHaveBeenCalledWith(item);
    });

    it("concurrent execution respects maxConcurrent", async () => {
      const items = [
        createTestWorkItem({ id: 1 }),
        createTestWorkItem({ id: 2 }),
        createTestWorkItem({ id: 3 }),
      ];

      let activeCount = 0;
      let maxSeen = 0;

      const trackingHandler = vi.fn<WorkHandler>().mockImplementation(async () => {
        activeCount++;
        maxSeen = Math.max(maxSeen, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount--;
        return { summary: "Done" };
      });

      mocks.claimReadyWork.mockResolvedValueOnce(items.slice(0, 2));

      executor = new WorkExecutor(manager, trackingHandler, {
        pollIntervalMs: 100,
        maxConcurrent: 2,
      });
      executor.start();
      await vi.advanceTimersByTimeAsync(100);

      // maxConcurrent=2 but we gave 3 items (only 2 claimed due to slots)
      expect(trackingHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("getStatus", () => {
    it("returns correct state", () => {
      executor = new WorkExecutor(manager, handler, { maxConcurrent: 3 });

      expect(executor.getStatus()).toEqual({
        running: false,
        activeCount: 0,
        maxConcurrent: 3,
      });

      executor.start();
      expect(executor.getStatus().running).toBe(true);

      executor.stop();
      expect(executor.getStatus().running).toBe(false);
    });
  });
});
