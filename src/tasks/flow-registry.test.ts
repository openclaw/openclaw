import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createFlowRecord,
  deleteFlowRecordById,
  getFlowById,
  listFlowRecords,
  resetFlowRegistryForTests,
  syncFlowFromTask,
  updateFlowRecordById,
} from "./flow-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-flow-registry-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      // Close the sqlite-backed registry before Windows temp-dir cleanup removes the store root.
      resetFlowRegistryForTests();
    }
  });
}

describe("flow-registry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetFlowRegistryForTests();
  });

  it("creates, updates, lists, and deletes flow records", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      const created = createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Investigate flaky test",
        status: "running",
        currentStep: "spawn_task",
      });

      expect(getFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        status: "running",
        currentStep: "spawn_task",
      });

      const updated = updateFlowRecordById(created.flowId, {
        status: "waiting",
        currentStep: "ask_user",
      });
      expect(updated).toMatchObject({
        flowId: created.flowId,
        status: "waiting",
        currentStep: "ask_user",
      });

      expect(listFlowRecords()).toEqual([
        expect.objectContaining({
          flowId: created.flowId,
          goal: "Investigate flaky test",
          status: "waiting",
        }),
      ]);

      expect(deleteFlowRecordById(created.flowId)).toBe(true);
      expect(getFlowById(created.flowId)).toBeUndefined();
      expect(listFlowRecords()).toEqual([]);
    });
  });

  it("applies minimal defaults for new flow records", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      const created = createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Background job",
      });

      expect(created).toMatchObject({
        flowId: expect.any(String),
        ownerSessionKey: "agent:main:main",
        goal: "Background job",
        status: "queued",
        notifyPolicy: "done_only",
      });
      expect(created.currentStep).toBeUndefined();
      expect(created.endedAt).toBeUndefined();
    });
  });

  it("preserves endedAt when later updates change other flow fields", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      const created = createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Finish a task",
        status: "succeeded",
        endedAt: 456,
      });

      const updated = updateFlowRecordById(created.flowId, {
        currentStep: "finish",
      });

      expect(updated).toMatchObject({
        flowId: created.flowId,
        currentStep: "finish",
        endedAt: 456,
      });
      expect(getFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        endedAt: 456,
      });
    });
  });

  it("stores blocked metadata and clears it when a later task resumes the same flow", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetFlowRegistryForTests();

      const created = createFlowRecord({
        ownerSessionKey: "agent:main:main",
        goal: "Fix permissions",
        status: "running",
      });

      const blocked = syncFlowFromTask({
        taskId: "task-blocked",
        parentFlowId: created.flowId,
        status: "succeeded",
        terminalOutcome: "blocked",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 200,
        endedAt: 200,
        terminalSummary: "Writable session required.",
      });

      expect(blocked).toMatchObject({
        flowId: created.flowId,
        status: "blocked",
        blockedTaskId: "task-blocked",
        blockedSummary: "Writable session required.",
        endedAt: 200,
      });

      const resumed = syncFlowFromTask({
        taskId: "task-retry",
        parentFlowId: created.flowId,
        status: "running",
        notifyPolicy: "done_only",
        label: "Fix permissions",
        task: "Fix permissions",
        lastEventAt: 260,
        progressSummary: "Retrying with writable session",
      });

      expect(resumed).toMatchObject({
        flowId: created.flowId,
        status: "running",
      });
      expect(resumed?.blockedTaskId).toBeUndefined();
      expect(resumed?.blockedSummary).toBeUndefined();
      expect(resumed?.endedAt).toBeUndefined();
    });
  });
});
