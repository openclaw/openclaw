import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadTaskFlowRegistryStateFromJson,
  saveTaskFlowRegistryStateToJson,
  upsertTaskFlowRecordToJson,
  deleteTaskFlowRecordFromJson,
  closeTaskFlowRegistryJsonStore,
} from "./task-flow-registry.store.json.js";
import { resolveTaskFlowRegistryJsonPath } from "./task-flow-registry.paths.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

describe("task-flow-registry.store.json", () => {
  const testFlow: TaskFlowRecord = {
    flowId: "test-flow-1",
    syncMode: "async",
    shape: "linear",
    ownerKey: "test-owner",
    requesterOrigin: { channel: "test", accountId: "test" },
    controllerId: "controller-1",
    revision: 1,
    status: "running",
    notifyPolicy: "always",
    goal: "Test flow goal",
    currentStep: "step-1",
    blockedTaskId: null,
    blockedSummary: null,
    state: { key: "value" },
    wait: null,
    cancelRequestedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
  };

  beforeEach(() => {
    // Clean up any existing test files
    const jsonPath = resolveTaskFlowRegistryJsonPath(process.env);
    if (existsSync(jsonPath)) {
      rmSync(jsonPath);
    }
  });

  afterEach(() => {
    closeTaskFlowRegistryJsonStore();
    // Clean up
    const jsonPath = resolveTaskFlowRegistryJsonPath(process.env);
    if (existsSync(jsonPath)) {
      rmSync(jsonPath);
    }
  });

  describe("loadTaskFlowRegistryStateFromJson", () => {
    it("should return empty state when no file exists", () => {
      const state = loadTaskFlowRegistryStateFromJson();
      expect(state.flows.size).toBe(0);
    });

    it("should load flows from existing file", () => {
      // First save some data
      const flows = new Map([[testFlow.flowId, testFlow]]);
      saveTaskFlowRegistryStateToJson({ flows });

      // Then load it
      const state = loadTaskFlowRegistryStateFromJson();
      expect(state.flows.size).toBe(1);
      expect(state.flows.get(testFlow.flowId)).toEqual(testFlow);
    });
  });

  describe("saveTaskFlowRegistryStateToJson", () => {
    it("should save flows to file", () => {
      const flows = new Map([[testFlow.flowId, testFlow]]);
      saveTaskFlowRegistryStateToJson({ flows });

      const jsonPath = resolveTaskFlowRegistryJsonPath(process.env);
      expect(existsSync(jsonPath)).toBe(true);
    });
  });

  describe("upsertTaskFlowRecordToJson", () => {
    it("should add new flow", () => {
      upsertTaskFlowRecordToJson(testFlow);
      const state = loadTaskFlowRegistryStateFromJson();
      expect(state.flows.get(testFlow.flowId)).toEqual(testFlow);
    });

    it("should update existing flow", () => {
      upsertTaskFlowRecordToJson(testFlow);
      const updatedFlow = { ...testFlow, status: "completed" as const };
      upsertTaskFlowRecordToJson(updatedFlow);
      const state = loadTaskFlowRegistryStateFromJson();
      expect(state.flows.get(testFlow.flowId)?.status).toBe("completed");
    });
  });

  describe("deleteTaskFlowRecordFromJson", () => {
    it("should delete flow", () => {
      upsertTaskFlowRecordToJson(testFlow);
      deleteTaskFlowRecordFromJson(testFlow.flowId);
      const state = loadTaskFlowRegistryStateFromJson();
      expect(state.flows.has(testFlow.flowId)).toBe(false);
    });
  });

  describe("closeTaskFlowRegistryJsonStore", () => {
    it("should persist data before clearing in-memory state", () => {
      upsertTaskFlowRecordToJson(testFlow);
      closeTaskFlowRegistryJsonStore();
      // After close, data should be persisted and reloadable
      const state = loadTaskRegistryStateFromJson();
      expect(state.flows.size).toBe(1);
      expect(state.flows.get(testFlow.flowId)).toEqual(testFlow);
    });
  });
});
