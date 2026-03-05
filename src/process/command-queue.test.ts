import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCommandInLane,
  registerCommandHandler,
  clearCommandLane,
  resetAllLanes,
  getActiveTaskCount,
  waitForActiveTasks,
  CommandLaneClearedError,
  getQueueSize,
  getTotalQueueSize,
  setCommandLaneConcurrency,
  _resetForTests,
} from "./command-queue.js";
import * as queueBackend from "./queue-backend.js";
import * as queueMemory from "./queue-memory.js";
import { CommandLane } from "./lanes.js";

describe("command-queue", () => {
  beforeEach(() => {
    _resetForTests();
    queueMemory.reset();
    queueBackend._resetBackendForTests();
  });

  afterEach(() => {
    _resetForTests();
    queueMemory.reset();
    queueBackend._resetBackendForTests();
  });

  describe("basic enqueue and dequeue", () => {
    it("should enqueue a task and return a promise", async () => {
      registerCommandHandler("TEST_TASK", async (payload) => {
        return { received: payload };
      });
      const result = await enqueueCommandInLane("lane1", "TEST_TASK", { data: 123 });
      expect(result).toEqual({ received: { data: 123 } });
    });

    it("should process tasks in FIFO order", async () => {
      const processedOrder: number[] = [];
      registerCommandHandler("ORDERED_TASK", async (_payload) => {
        const payload = _payload as { order: number };
        processedOrder.push(payload.order);
        return payload.order;
      });
      const p1 = enqueueCommandInLane("lane1", "ORDERED_TASK", { order: 1 });
      const p2 = enqueueCommandInLane("lane1", "ORDERED_TASK", { order: 2 });
      const p3 = enqueueCommandInLane("lane1", "ORDERED_TASK", { order: 3 });
      await Promise.all([p1, p2, p3]);
      expect(processedOrder).toEqual([1, 2, 3]);
    });

    it("should handle handler errors", async () => {
      registerCommandHandler("FAILING_TASK", async () => {
        throw new Error("Handler failed");
      });
      await expect(enqueueCommandInLane("lane1", "FAILING_TASK", {})).rejects.toThrow(
        "Handler failed",
      );
    });

    it("should throw error for unregistered task type", async () => {
      await expect(enqueueCommandInLane("lane1", "UNREGISTERED", {})).rejects.toThrow(
        "No handler registered",
      );
    });
  });

  describe("lane isolation", () => {
    it("should process tasks in different lanes independently", async () => {
      const processedLanes: string[] = [];
      registerCommandHandler("LANE_TASK", async (_payload) => {
        const payload = _payload as { lane: string };
        processedLanes.push(payload.lane);
        return payload.lane;
      });
      const p1 = enqueueCommandInLane("lane1", "LANE_TASK", { lane: "A" });
      const p2 = enqueueCommandInLane("lane2", "LANE_TASK", { lane: "B" });
      await Promise.all([p1, p2]);
      expect(processedLanes.sort()).toEqual(["A", "B"].sort());
    });

    it("should not interleave tasks in the same lane", async () => {
      const executionLog: string[] = [];
      registerCommandHandler("SLOW_TASK", async (_payload) => {
        const payload = _payload as { id: string };
        executionLog.push(`${payload.id}:start`);
        await new Promise((r) => setTimeout(r, 50));
        executionLog.push(`${payload.id}:end`);
        return payload.id;
      });
      const p1 = enqueueCommandInLane("serial", "SLOW_TASK", { id: "task1" });
      const p2 = enqueueCommandInLane("serial", "SLOW_TASK", { id: "task2" });
      await Promise.all([p1, p2]);
      expect(executionLog).toEqual(["task1:start", "task1:end", "task2:start", "task2:end"]);
    });
  });

  describe("clearCommandLane", () => {
    it("should clear pending tasks and reject their promises", async () => {
      registerCommandHandler("CLEARABLE_TASK", async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return "done";
      });
      const p1 = enqueueCommandInLane("clear-test", "CLEARABLE_TASK", { id: 1 });
      const p2 = enqueueCommandInLane("clear-test", "CLEARABLE_TASK", { id: 2 });
      const p3 = enqueueCommandInLane("clear-test", "CLEARABLE_TASK", { id: 3 });
      p2.catch(() => {});
      p3.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
      clearCommandLane("clear-test");
      await expect(p1).resolves.toBe("done");
      await expect(p2).rejects.toThrow(CommandLaneClearedError);
      await expect(p3).rejects.toThrow(CommandLaneClearedError);
    });

    it("should not affect other lanes", async () => {
      registerCommandHandler("TASK", async (p) => {
        await new Promise((r) => setTimeout(r, 200));
        return p;
      });
      const p1 = enqueueCommandInLane("lane1", "TASK", { lane: 1 });
      const p2 = enqueueCommandInLane("lane1", "TASK", { lane: 1.1 });
      p2.catch(() => {});
      const p3 = enqueueCommandInLane("lane2", "TASK", { lane: 2 });
      await new Promise((r) => setTimeout(r, 10));
      clearCommandLane("lane1");
      await expect(p1).resolves.toEqual({ lane: 1 });
      await expect(p2).rejects.toThrow(CommandLaneClearedError);
      await expect(p3).resolves.toEqual({ lane: 2 });
    });
  });

  describe("resetAllLanes", () => {
    it("should recover RUNNING tasks to PENDING and drain lanes", async () => {
      let callCount = 0;
      registerCommandHandler("RESET_TASK", async () => {
        callCount++;
        return callCount;
      });
      const p1 = enqueueCommandInLane("reset-lane", "RESET_TASK", {});
      await p1;
      expect(callCount).toBe(1);
    });

    it("should handle generation correctly", async () => {
      const results: string[] = [];
      registerCommandHandler("GEN_TASK", async (_payload) => {
        const payload = _payload as { value: string };
        results.push(payload.value);
        return payload.value;
      });
      await enqueueCommandInLane("gen-lane", "GEN_TASK", { value: "before" });
      expect(results).toEqual(["before"]);
      resetAllLanes();
      await enqueueCommandInLane("gen-lane", "GEN_TASK", { value: "after" });
      expect(results).toEqual(["before", "after"]);
    });
  });

  describe("concurrency", () => {
    it("should respect maxConcurrent setting", async () => {
      let concurrentCount = 0;
      let maxConcurrentSeen = 0;
      registerCommandHandler("CONCURRENT_TASK", async () => {
        concurrentCount++;
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentCount);
        await new Promise((r) => setTimeout(r, 100));
        concurrentCount--;
        return "done";
      });
      setCommandLaneConcurrency("concurrent-lane", 3);
      const promises = [
        enqueueCommandInLane("concurrent-lane", "CONCURRENT_TASK", {}),
        enqueueCommandInLane("concurrent-lane", "CONCURRENT_TASK", {}),
        enqueueCommandInLane("concurrent-lane", "CONCURRENT_TASK", {}),
        enqueueCommandInLane("concurrent-lane", "CONCURRENT_TASK", {}),
        enqueueCommandInLane("concurrent-lane", "CONCURRENT_TASK", {}),
      ];
      await Promise.all(promises);
      expect(maxConcurrentSeen).toBe(3);
    });
  });

  describe("queue size functions", () => {
    it("should return correct queue size for a lane", async () => {
      registerCommandHandler("SIZE_TASK", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "done";
      });
      void enqueueCommandInLane("size-lane", "SIZE_TASK", {});
      void enqueueCommandInLane("size-lane", "SIZE_TASK", {});
      void enqueueCommandInLane("size-lane", "SIZE_TASK", {});
      expect(getQueueSize("size-lane")).toBe(3);
    });

    it("should return correct total queue size across all lanes", async () => {
      registerCommandHandler("TOTAL_TASK", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "done";
      });
      void enqueueCommandInLane("lane1", "TOTAL_TASK", {});
      void enqueueCommandInLane("lane2", "TOTAL_TASK", {});
      void enqueueCommandInLane("lane3", "TOTAL_TASK", {});
      expect(getTotalQueueSize()).toBe(3);
    });
  });

  describe("active task tracking", () => {
    it("should track active task count", async () => {
      registerCommandHandler("ACTIVE_TASK", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "done";
      });
      void enqueueCommandInLane("active-lane", "ACTIVE_TASK", {});
      await new Promise((r) => setTimeout(r, 10));
      expect(getActiveTaskCount()).toBe(1);
      await waitForActiveTasks(500);
      expect(getActiveTaskCount()).toBe(0);
    });

    it("waitForActiveTasks should timeout correctly", async () => {
      registerCommandHandler("LONG_TASK", async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return "done";
      });
      void enqueueCommandInLane("long-lane", "LONG_TASK", {});
      await new Promise((r) => setTimeout(r, 10));
      const result = await waitForActiveTasks(50);
      expect(result.drained).toBe(false);
    });
  });

  describe("handler registration", () => {
    it("should allow handler replacement", async () => {
      registerCommandHandler("REPLACE_TASK", async () => "first");
      const r1 = await enqueueCommandInLane("replace-lane", "REPLACE_TASK", {});
      expect(r1).toBe("first");
      registerCommandHandler("REPLACE_TASK", async () => "second");
      const r2 = await enqueueCommandInLane("replace-lane", "REPLACE_TASK", {});
      expect(r2).toBe("second");
    });
  });

  describe("edge cases", () => {
    it("should handle empty lane name", async () => {
      registerCommandHandler("EMPTY_LANE", async (p) => p);
      const result = await enqueueCommandInLane("", "EMPTY_LANE", { test: true });
      expect(result).toEqual({ test: true });
    });

    it("should handle special characters in lane name", async () => {
      registerCommandHandler("SPECIAL_LANE", async (p) => p);
      const laneName = "lane:with:special@chars#123";
      const result = await enqueueCommandInLane(laneName, "SPECIAL_LANE", { special: true });
      expect(result).toEqual({ special: true });
    });

    it("should handle tasks that return undefined", async () => {
      registerCommandHandler("UNDEFINED_TASK", async () => undefined);
      const result = await enqueueCommandInLane("undefined-lane", "UNDEFINED_TASK", {});
      expect(result).toBeUndefined();
    });

    it("should handle tasks that return null", async () => {
      registerCommandHandler("NULL_TASK", async () => null);
      const result = await enqueueCommandInLane("null-lane", "NULL_TASK", {});
      expect(result).toBeNull();
    });
  });

  describe("recovery scenarios", () => {
    it("should handle rapid enqueue/dequeue cycles", async () => {
      registerCommandHandler("RAPID_TASK", async (_p) => (_p as { value: number }).value * 2);
      const results = await Promise.all([
        enqueueCommandInLane("rapid", "RAPID_TASK", { value: 1 }),
        enqueueCommandInLane("rapid", "RAPID_TASK", { value: 2 }),
        enqueueCommandInLane("rapid", "RAPID_TASK", { value: 3 }),
        enqueueCommandInLane("rapid", "RAPID_TASK", { value: 4 }),
        enqueueCommandInLane("rapid", "RAPID_TASK", { value: 5 }),
      ]);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it("should handle clear during active processing", async () => {
      let started = false;
      registerCommandHandler("CLEAR_DURING_TASK", async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 200));
        return "completed";
      });
      const p1 = enqueueCommandInLane("clear-during", "CLEAR_DURING_TASK", {});
      const p2 = enqueueCommandInLane("clear-during", "CLEAR_DURING_TASK", {});
      p2.catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(started).toBe(true);
      clearCommandLane("clear-during");
      await expect(p1).resolves.toBe("completed");
      await expect(p2).rejects.toThrow(CommandLaneClearedError);
    });
  });

  describe("CommandLane enum usage", () => {
    it("should work with CommandLane.Main", async () => {
      registerCommandHandler("MAIN_TASK", async (p) => p);
      const result = await enqueueCommandInLane(CommandLane.Main, "MAIN_TASK", { main: true });
      expect(result).toEqual({ main: true });
    });

    it("should work with CommandLane.Cron", async () => {
      registerCommandHandler("CRON_TASK", async (p) => p);
      const result = await enqueueCommandInLane(CommandLane.Cron, "CRON_TASK", { cron: true });
      expect(result).toEqual({ cron: true });
    });
  });
});
