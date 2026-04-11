import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadTaskRegistryStateFromJson,
  saveTaskRegistryStateToJson,
  upsertTaskRegistryRecordToJson,
  upsertTaskWithDeliveryStateToJson,
  deleteTaskRegistryRecordFromJson,
  deleteTaskAndDeliveryStateFromJson,
  upsertTaskDeliveryStateToJson,
  deleteTaskDeliveryStateFromJson,
  closeTaskRegistryJsonStore,
} from "./task-registry.store.json.js";
import { resolveTaskRegistryJsonPath } from "./task-registry.paths.js";
import type { TaskRecord, TaskDeliveryState } from "./task-registry.types.js";

describe("task-registry.store.json", () => {
  const testTask: TaskRecord = {
    taskId: "test-task-1",
    runtime: "subagent",
    taskKind: "test",
    sourceId: "test-source",
    requesterSessionKey: "test-session",
    ownerKey: "test-owner",
    scopeKind: "session",
    childSessionKey: "child-session",
    parentFlowId: "flow-1",
    parentTaskId: "parent-1",
    agentId: "agent-1",
    runId: "run-1",
    label: "test-label",
    task: "Test task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "always",
    createdAt: Date.now(),
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  };

  const testDeliveryState: TaskDeliveryState = {
    taskId: "test-task-1",
    requesterOrigin: { channel: "test", accountId: "test" },
    lastNotifiedEventAt: Date.now(),
  };

  beforeEach(() => {
    // Clean up any existing test files
    const jsonPath = resolveTaskRegistryJsonPath(process.env);
    if (existsSync(jsonPath)) {
      rmSync(jsonPath);
    }
    const dir = dirname(jsonPath);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    closeTaskRegistryJsonStore();
    // Clean up
    const jsonPath = resolveTaskRegistryJsonPath(process.env);
    if (existsSync(jsonPath)) {
      rmSync(jsonPath);
    }
  });

  describe("loadTaskRegistryStateFromJson", () => {
    it("should return empty state when no file exists", () => {
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.size).toBe(0);
      expect(state.deliveryStates.size).toBe(0);
    });

    it("should load tasks from existing file", () => {
      // First save some data
      const tasks = new Map([[testTask.taskId, testTask]]);
      const deliveryStates = new Map([[testDeliveryState.taskId, testDeliveryState]]);
      saveTaskRegistryStateToJson({ tasks, deliveryStates });

      // Then load it
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get(testTask.taskId)).toEqual(testTask);
      expect(state.deliveryStates.size).toBe(1);
      expect(state.deliveryStates.get(testDeliveryState.taskId)).toEqual(testDeliveryState);
    });
  });

  describe("saveTaskRegistryStateToJson", () => {
    it("should save tasks to file", () => {
      const tasks = new Map([[testTask.taskId, testTask]]);
      const deliveryStates = new Map([[testDeliveryState.taskId, testDeliveryState]]);
      saveTaskRegistryStateToJson({ tasks, deliveryStates });

      const jsonPath = resolveTaskRegistryJsonPath(process.env);
      expect(existsSync(jsonPath)).toBe(true);
    });
  });

  describe("upsertTaskRegistryRecordToJson", () => {
    it("should add new task", () => {
      upsertTaskRegistryRecordToJson(testTask);
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.get(testTask.taskId)).toEqual(testTask);
    });

    it("should update existing task", () => {
      upsertTaskRegistryRecordToJson(testTask);
      const updatedTask = { ...testTask, status: "completed" as const };
      upsertTaskRegistryRecordToJson(updatedTask);
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.get(testTask.taskId)?.status).toBe("completed");
    });
  });

  describe("upsertTaskWithDeliveryStateToJson", () => {
    it("should add task with delivery state", () => {
      upsertTaskWithDeliveryStateToJson({
        task: testTask,
        deliveryState: testDeliveryState,
      });
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.get(testTask.taskId)).toEqual(testTask);
      expect(state.deliveryStates.get(testTask.taskId)).toEqual(testDeliveryState);
    });

    it("should remove delivery state when not provided", () => {
      upsertTaskWithDeliveryStateToJson({
        task: testTask,
        deliveryState: testDeliveryState,
      });
      upsertTaskWithDeliveryStateToJson({
        task: testTask,
      });
      const state = loadTaskRegistryStateFromJson();
      expect(state.deliveryStates.has(testTask.taskId)).toBe(false);
    });
  });

  describe("deleteTaskRegistryRecordFromJson", () => {
    it("should delete task", () => {
      upsertTaskRegistryRecordToJson(testTask);
      deleteTaskRegistryRecordFromJson(testTask.taskId);
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.has(testTask.taskId)).toBe(false);
    });
  });

  describe("deleteTaskAndDeliveryStateFromJson", () => {
    it("should delete task and delivery state", () => {
      upsertTaskWithDeliveryStateToJson({
        task: testTask,
        deliveryState: testDeliveryState,
      });
      deleteTaskAndDeliveryStateFromJson(testTask.taskId);
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.has(testTask.taskId)).toBe(false);
      expect(state.deliveryStates.has(testTask.taskId)).toBe(false);
    });
  });

  describe("upsertTaskDeliveryStateToJson", () => {
    it("should add delivery state", () => {
      upsertTaskDeliveryStateToJson(testDeliveryState);
      const state = loadTaskRegistryStateFromJson();
      expect(state.deliveryStates.get(testDeliveryState.taskId)).toEqual(testDeliveryState);
    });
  });

  describe("deleteTaskDeliveryStateFromJson", () => {
    it("should delete delivery state", () => {
      upsertTaskDeliveryStateToJson(testDeliveryState);
      deleteTaskDeliveryStateFromJson(testDeliveryState.taskId);
      const state = loadTaskRegistryStateFromJson();
      expect(state.deliveryStates.has(testDeliveryState.taskId)).toBe(false);
    });
  });

  describe("closeTaskRegistryJsonStore", () => {
    it("should clear in-memory state", () => {
      upsertTaskRegistryRecordToJson(testTask);
      closeTaskRegistryJsonStore();
      // After close, loading should return empty
      const state = loadTaskRegistryStateFromJson();
      expect(state.tasks.size).toBe(0);
    });
  });
});
