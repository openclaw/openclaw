import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as memoryBackend from "./queue-memory.js";

describe("queue-memory", () => {
  beforeEach(() => {
    memoryBackend.reset();
  });

  afterEach(() => {
    memoryBackend.reset();
  });

  describe("insertTask", () => {
    it("should insert a task and return its ID", () => {
      const id = memoryBackend.insertTask("lane1", "TEST_TASK", { foo: "bar" });
      expect(id).toBe(1);
    });

    it("should increment IDs for subsequent tasks", () => {
      const id1 = memoryBackend.insertTask("lane1", "TASK1", {});
      const id2 = memoryBackend.insertTask("lane1", "TASK2", {});
      const id3 = memoryBackend.insertTask("lane2", "TASK3", {});
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it("should store payload as JSON string", () => {
      memoryBackend.insertTask("lane1", "TEST", { nested: { value: 123 } });
      const task = memoryBackend.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(JSON.parse(task!.payload)).toEqual({ nested: { value: 123 } });
    });

    it("should set initial status to PENDING", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      const task = memoryBackend.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
      expect(task!.status).toBe("RUNNING");
    });
  });

  describe("claimNextPendingTask", () => {
    it("should return null when no tasks exist", () => {
      const task = memoryBackend.claimNextPendingTask("lane1");
      expect(task).toBeNull();
    });

    it("should return null when no tasks exist for the specified lane", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      const task = memoryBackend.claimNextPendingTask("lane2");
      expect(task).toBeNull();
    });

    it("should claim the oldest PENDING task for the lane (FIFO)", () => {
      memoryBackend.insertTask("lane1", "TASK1", { order: 1 });
      memoryBackend.insertTask("lane1", "TASK2", { order: 2 });
      memoryBackend.insertTask("lane1", "TASK3", { order: 3 });
      const task1 = memoryBackend.claimNextPendingTask("lane1");
      expect(task1).not.toBeNull();
      expect(JSON.parse(task1!.payload)).toEqual({ order: 1 });
      const task2 = memoryBackend.claimNextPendingTask("lane1");
      expect(task2).not.toBeNull();
      expect(JSON.parse(task2!.payload)).toEqual({ order: 2 });
    });

    it("should not claim non-PENDING tasks", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id, "done");
      const task = memoryBackend.claimNextPendingTask("lane1");
      expect(task).toBeNull();
    });
  });

  describe("resolveTask", () => {
    it("should set status to COMPLETED", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id, { result: "success" });
      const result = memoryBackend.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("COMPLETED");
    });

    it("should store result as JSON", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id, { data: [1, 2, 3] });
      const result = memoryBackend.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.result).toEqual({ data: [1, 2, 3] });
    });
  });

  describe("rejectTask", () => {
    it("should set status to FAILED", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.rejectTask(id, "Something went wrong");
      const result = memoryBackend.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("FAILED");
    });

    it("should store error message", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.rejectTask(id, "Error: timeout");
      const result = memoryBackend.getTaskResult(id);
      expect(result).not.toBeNull();
      expect(result!.error_msg).toBe("Error: timeout");
    });
  });

  describe("countQueueByStatus", () => {
    it("should return 0 for empty queue", () => {
      expect(memoryBackend.countQueueByStatus("lane1")).toBe(0);
    });

    it("should count PENDING and RUNNING by default", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane1", "TEST", {});
      expect(memoryBackend.countQueueByStatus("lane1")).toBe(3);
    });

    it("should filter by specific status when provided", () => {
      const id1 = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id1);
      expect(memoryBackend.countQueueByStatus("lane1", "PENDING")).toBe(1);
      expect(memoryBackend.countQueueByStatus("lane1", "COMPLETED")).toBe(1);
    });
  });

  describe("countTotalQueue", () => {
    it("should count PENDING and RUNNING across all lanes", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane2", "TEST", {});
      memoryBackend.insertTask("lane3", "TEST", {});
      expect(memoryBackend.countTotalQueue()).toBe(3);
    });

    it("should not count COMPLETED or FAILED tasks", () => {
      const id1 = memoryBackend.insertTask("lane1", "TEST", {});
      const id2 = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id1);
      memoryBackend.rejectTask(id2, "error");
      expect(memoryBackend.countTotalQueue()).toBe(0);
    });
  });

  describe("clearLaneTasks", () => {
    it("should remove all PENDING tasks from the specified lane", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane2", "TEST", {});
      const removed = memoryBackend.clearLaneTasks("lane1");
      expect(removed).toBe(2);
      expect(memoryBackend.countQueueByStatus("lane1")).toBe(0);
      expect(memoryBackend.countQueueByStatus("lane2")).toBe(1);
    });

    it("should not remove RUNNING tasks", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.claimNextPendingTask("lane1");
      const removed = memoryBackend.clearLaneTasks("lane1");
      expect(removed).toBe(0);
    });
  });

  describe("hasActiveTasks", () => {
    it("should return false when no RUNNING tasks", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      expect(memoryBackend.hasActiveTasks()).toBe(false);
    });

    it("should return true when there are RUNNING tasks", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.claimNextPendingTask("lane1");
      expect(memoryBackend.hasActiveTasks()).toBe(true);
    });
  });

  describe("recoverRunningTasks", () => {
    it("should return empty array when no RUNNING tasks", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      const lanes = memoryBackend.recoverRunningTasks();
      expect(lanes).toEqual([]);
    });

    it("should reset RUNNING tasks to PENDING", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.claimNextPendingTask("lane1");
      const lanes = memoryBackend.recoverRunningTasks();
      expect(lanes).toEqual(["lane1"]);
      const task = memoryBackend.claimNextPendingTask("lane1");
      expect(task).not.toBeNull();
    });
  });

  describe("getTaskResult", () => {
    it("should return null for nonexistent task", () => {
      const result = memoryBackend.getTaskResult(999);
      expect(result).toBeNull();
    });

    it("should return status, result, and error_msg", () => {
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.resolveTask(id, { foo: "bar" });
      const result = memoryBackend.getTaskResult(id);
      expect(result).toEqual({
        status: "COMPLETED",
        result: { foo: "bar" },
        error_msg: null,
      });
    });
  });

  describe("reset", () => {
    it("should clear all tasks", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.insertTask("lane2", "TEST", {});
      memoryBackend.reset();
      expect(memoryBackend.countTotalQueue()).toBe(0);
    });

    it("should reset ID counter", () => {
      memoryBackend.insertTask("lane1", "TEST", {});
      memoryBackend.reset();
      const id = memoryBackend.insertTask("lane1", "TEST", {});
      expect(id).toBe(1);
    });
  });
});
