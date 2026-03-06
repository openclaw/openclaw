import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as queueDb from "./queue-db.js";

describe("queue-db", () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(os.tmpdir(), `queue-test-${Date.now()}.db`);
    queueDb.closeQueueDB();
    queueDb.initQueueDB(tempDbPath);
  });

  afterEach(() => {
    queueDb.closeQueueDB();
    try {
      fs.unlinkSync(tempDbPath);
      fs.unlinkSync(`${tempDbPath}-wal`);
      fs.unlinkSync(`${tempDbPath}-shm`);
    } catch {
      // ignore cleanup errors
    }
  });

  describe("insertTask", () => {
    it("should insert a task and return its ID", () => {
      const id = queueDb.insertTask("lane1", "TEST_TASK", { foo: "bar" });
      expect(id).toBeGreaterThan(0);
    });

    it("should store payload as JSON string", () => {
      queueDb.insertTask("lane1", "TEST", { nested: { value: 123 } });
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(JSON.parse(task!.payload)).toEqual({ nested: { value: 123 } });
    });

    it("should set initial status to PENDING", () => {
      queueDb.insertTask("lane1", "TEST", {});
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(task!.status).toBe("RUNNING");
    });
  });

  describe("claimNextPendingTask", () => {
    it("should return null when no tasks exist", () => {
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).toBeNull();
    });

    it("should return null when no tasks exist for the specified lane", () => {
      queueDb.insertTask("lane1", "TEST", {});
      const task = queueDb.claimNextPendingTask("lane2");
      expect(task).toBeNull();
    });

    it("should claim the oldest PENDING task for the lane (FIFO)", async () => {
      queueDb.insertTask("lane1", "TASK1", { order: 1 });
      await new Promise((r) => setTimeout(r, 10));
      queueDb.insertTask("lane1", "TASK2", { order: 2 });
      await new Promise((r) => setTimeout(r, 10));
      queueDb.insertTask("lane1", "TASK3", { order: 3 });

      const task1 = queueDb.claimNextPendingTask("lane1");
      expect(task1).not.toBeNull();
      expect(JSON.parse(task1!.payload)).toEqual({ order: 1 });

      const task2 = queueDb.claimNextPendingTask("lane1");
      expect(task2).not.toBeNull();
      expect(JSON.parse(task2!.payload)).toEqual({ order: 2 });
    });

    it("should set status to RUNNING when claimed", () => {
      queueDb.insertTask("lane1", "TEST", {});
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(task!.status).toBe("RUNNING");
    });

    it("should not claim non-PENDING tasks", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id, "done");
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).toBeNull();
    });
  });

  describe("resolveTask", () => {
    it("should set status to COMPLETED", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id, { result: "success" });
      const result = queueDb.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("COMPLETED");
    });

    it("should store result as JSON", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id, { data: [1, 2, 3] });
      const result = queueDb.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.result).toEqual({ data: [1, 2, 3] });
    });
  });

  describe("rejectTask", () => {
    it("should set status to FAILED", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.rejectTask(id, "Something went wrong");
      const result = queueDb.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("FAILED");
    });

    it("should store error message", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.rejectTask(id, "Error: timeout");
      const result = queueDb.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.error_msg).toBe("Error: timeout");
    });
  });

  describe("countQueueByStatus", () => {
    it("should return 0 for empty queue", () => {
      expect(queueDb.countQueueByStatus("lane1")).toBe(0);
    });

    it("should count PENDING and RUNNING by default", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane1", "TEST", {});
      expect(queueDb.countQueueByStatus("lane1")).toBe(3);
    });

    it("should filter by specific status when provided", () => {
      const id1 = queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id1);
      expect(queueDb.countQueueByStatus("lane1", "PENDING")).toBe(1);
      expect(queueDb.countQueueByStatus("lane1", "COMPLETED")).toBe(1);
    });
  });

  describe("countTotalQueue", () => {
    it("should count PENDING and RUNNING across all lanes", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      queueDb.insertTask("lane3", "TEST", {});
      expect(queueDb.countTotalQueue()).toBe(3);
    });

    it("should not count COMPLETED or FAILED tasks", () => {
      const id1 = queueDb.insertTask("lane1", "TEST", {});
      const id2 = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id1);
      queueDb.rejectTask(id2, "error");
      expect(queueDb.countTotalQueue()).toBe(0);
    });
  });

  describe("clearLaneTasks", () => {
    it("should remove all PENDING tasks from the specified lane", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      const removed = queueDb.clearLaneTasks("lane1");
      expect(removed).toBe(2);
      expect(queueDb.countQueueByStatus("lane1")).toBe(0);
      expect(queueDb.countQueueByStatus("lane2")).toBe(1);
    });

    it("should not remove RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      const removed = queueDb.clearLaneTasks("lane1");
      expect(removed).toBe(0);
    });
  });

  describe("getPendingTaskIdsForLane", () => {
    it("should return IDs of all PENDING tasks in the lane", () => {
      const id1 = queueDb.insertTask("lane1", "TEST", {});
      const id2 = queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      const ids = queueDb.getPendingTaskIdsForLane("lane1");
      expect(ids.toSorted((a, b) => a - b)).toEqual([id1, id2].toSorted((a, b) => a - b));
    });

    it("should return empty array if no PENDING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      const ids = queueDb.getPendingTaskIdsForLane("lane1");
      expect(ids).toEqual([]);
    });
  });

  describe("hasActiveTasks", () => {
    it("should return false when no RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      expect(queueDb.hasActiveTasks()).toBe(false);
    });

    it("should return true when there are RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      expect(queueDb.hasActiveTasks()).toBe(true);
    });
  });

  describe("recoverRunningTasks", () => {
    it("should return empty array when no RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      const lanes = queueDb.recoverRunningTasks();
      expect(lanes).toEqual([]);
    });

    it("should reset RUNNING tasks to PENDING", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      const lanes = queueDb.recoverRunningTasks();
      expect(lanes).toEqual(["lane1"]);
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
    });

    it("should return affected lanes", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      queueDb.claimNextPendingTask("lane2");
      const lanes = queueDb.recoverRunningTasks();
      expect(lanes.toSorted()).toEqual(["lane1", "lane2"].toSorted());
    });
  });

  describe("getTaskResult", () => {
    it("should return null for nonexistent task", () => {
      const result = queueDb.getTaskResult(999);
      expect(result).toBeNull();
    });

    it("should return status, result, and error_msg", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id, { foo: "bar" });
      const result = queueDb.getTaskResult(id);
      expect(result).toEqual({
        status: "COMPLETED",
        result: { foo: "bar" },
        error_msg: null,
      });
    });
  });

  describe("getPendingLanes", () => {
    it("should return lanes with PENDING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      const lanes = queueDb.getPendingLanes();
      expect(lanes.toSorted()).toEqual(["lane1", "lane2"].toSorted());
    });

    it("should not include lanes with only RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      const lanes = queueDb.getPendingLanes();
      expect(lanes).toEqual([]);
    });
  });

  describe("markStaleTasks", () => {
    it("should mark all PENDING and RUNNING tasks as FAILED", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.insertTask("lane2", "TEST", {});
      const count = queueDb.markStaleTasks("stale: test");
      expect(count).toBe(2);
      const result1 = queueDb.getTaskResult(1);
      const result2 = queueDb.getTaskResult(2);
      expect(result1!.status).toBe("FAILED");
      expect(result2!.status).toBe("FAILED");
    });

    it("should not affect COMPLETED or FAILED tasks", () => {
      const id1 = queueDb.insertTask("lane1", "TEST", {});
      queueDb.resolveTask(id1, "done");
      const id2 = queueDb.insertTask("lane1", "TEST", {});
      queueDb.rejectTask(id2, "original error");
      const count = queueDb.markStaleTasks("stale");
      expect(count).toBe(0);
      const result1 = queueDb.getTaskResult(id1);
      expect(result1!.status).toBe("COMPLETED");
    });
  });

  describe("getRecoverableTasks", () => {
    it("should return all PENDING tasks with full payload", () => {
      queueDb.insertTask("lane1", "TEST1", { data: 1 });
      queueDb.insertTask("lane2", "TEST2", { data: 2 });
      queueDb.insertTask("lane3", "TEST3", { data: 3 });
      const tasks = queueDb.getRecoverableTasks();
      expect(tasks.length).toBe(3);
      const parsedPayloads = tasks.map((t) => JSON.parse(t.payload));
      expect(parsedPayloads.map((p) => p.data).toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it("should not include RUNNING tasks", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      const tasks = queueDb.getRecoverableTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("persistence and restart simulation", () => {
    it("should persist tasks across close/reopen", () => {
      const id = queueDb.insertTask("lane1", "TEST", { data: "persistent" });
      queueDb.closeQueueDB();
      queueDb.initQueueDB(tempDbPath);
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(task!.id).toBe(id);
      expect(JSON.parse(task!.payload)).toEqual({ data: "persistent" });
    });

    it("should recover RUNNING tasks after restart", () => {
      queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      queueDb.closeQueueDB();
      queueDb.initQueueDB(tempDbPath);
      const lanes = queueDb.recoverRunningTasks();
      expect(lanes).toEqual(["lane1"]);
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
    });

    it("should preserve COMPLETED results after restart", () => {
      const id = queueDb.insertTask("lane1", "TEST", {});
      queueDb.claimNextPendingTask("lane1");
      queueDb.resolveTask(id, { answer: 42 });
      queueDb.closeQueueDB();
      queueDb.initQueueDB(tempDbPath);
      const result = queueDb.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("COMPLETED");
      expect(result!.result).toEqual({ answer: 42 });
    });
  });

  describe("concurrent access patterns", () => {
    it("should handle rapid sequential inserts and claims", () => {
      for (let i = 0; i < 100; i++) {
        queueDb.insertTask("lane1", "TEST", { index: i });
      }
      for (let i = 0; i < 100; i++) {
        const task = queueDb.claimNextPendingTask("lane1");
        expect(task).not.toBeNull();
        expect(JSON.parse(task!.payload).index).toBe(i);
      }
      const task = queueDb.claimNextPendingTask("lane1");
      expect(task).toBeNull();
    });
  });
});
