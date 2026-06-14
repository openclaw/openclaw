// Covers maintenance reconciliation for managed task-flow records.
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun as createRunningTaskRunOrNull } from "./task-executor.js";
import {
  createFlowRecord as createFlowRecordOrNull,
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function createFlowRecord(params: Parameters<typeof createFlowRecordOrNull>[0]): TaskFlowRecord {
  const flow = createFlowRecordOrNull(params);
  if (!flow) {
    throw new Error("expected TaskFlow creation to succeed");
  }
  return flow;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createRunningTaskRun(
  params: Parameters<typeof createRunningTaskRunOrNull>[0],
): TaskRecord {
  const task = createRunningTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected running task creation to succeed");
  }
  return task;
}

async function withTaskFlowMaintenanceStateDir(
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-maintenance-",
    },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry maintenance", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("finalizes cancel-requested managed flows once no child tasks remain active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
        expired: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected cancel-requested flow to remain registered");
      }
      expect(storedFlow.flowId).toBe(flow.flowId);
      expect(storedFlow.status).toBe("cancelled");
      expect(storedFlow.cancelRequestedAt).toBe(100);
    });
  });

  it("prunes old terminal flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      const oldFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
        expired: 0,
      });
      expect(getTaskFlowById(oldFlow.flowId)).toBeUndefined();
    });
  });

  it("repairs terminal mirrored flows whose delivery updates outlived endedAt", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createFlowRecord({
        syncMode: "task_mirrored",
        ownerKey: "agent:main:main",
        goal: "Failed ACP task",
        status: "failed",
        createdAt: 100,
        updatedAt: 250,
        endedAt: 200,
      });

      expect(getInspectableTaskFlowAuditSummary().byCode.inconsistent_timestamps).toBe(1);
      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
        expired: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected repaired mirrored flow to remain registered");
      }
      expect(storedFlow.endedAt).toBe(200);
      expect(storedFlow.updatedAt).toBe(200);
      expect(getInspectableTaskFlowAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("does not finalize cancel-requested flows while a child task is still active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait for child cancel",
        status: "running",
        createdAt: 1,
        updatedAt: 100,
      });

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:child",
        runId: "run-active-child",
        task: "Inspect repo",
        startedAt: 100,
        lastEventAt: 100,
      });

      const cancelResult = requestFlowCancel({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        cancelRequestedAt: 100,
        updatedAt: 100,
      });
      expect(cancelResult.applied).toBe(true);
      if (!cancelResult.applied) {
        throw new Error("Expected flow cancel request to apply");
      }
      expect(cancelResult.flow.flowId).toBe(flow.flowId);
      expect(cancelResult.flow.cancelRequestedAt).toBe(100);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });
      const storedFlow = getTaskFlowById(flow.flowId);
      if (!storedFlow) {
        throw new Error("Expected active child flow to remain registered");
      }
      expect(storedFlow.flowId).toBe(flow.flowId);
      expect(storedFlow.status).toBe("running");
      expect(storedFlow.cancelRequestedAt).toBe(100);
      expect(child.parentFlowId).toBe(flow.flowId);
    });
  });

  it("prunes many old terminal flows while keeping fresh and active ones", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();

      for (let index = 0; index < 25; index += 1) {
        createManagedTaskFlow({
          ownerKey: `agent:main:${index}`,
          controllerId: "tests/task-flow-maintenance",
          goal: `Old terminal flow ${index}`,
          status: "succeeded",
          createdAt: now - 8 * 24 * 60 * 60_000 - index,
          updatedAt: now - 8 * 24 * 60 * 60_000 - index,
          endedAt: now - 8 * 24 * 60 * 60_000 - index,
        });
      }

      const fresh = createManagedTaskFlow({
        ownerKey: "agent:main:fresh",
        controllerId: "tests/task-flow-maintenance",
        goal: "Fresh terminal flow",
        status: "succeeded",
        createdAt: now - 2 * 24 * 60 * 60_000,
        updatedAt: now - 2 * 24 * 60 * 60_000,
        endedAt: now - 2 * 24 * 60 * 60_000,
      });

      const running = createManagedTaskFlow({
        ownerKey: "agent:main:running",
        controllerId: "tests/task-flow-maintenance",
        goal: "Active flow",
        status: "running",
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 25,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 25,
        expired: 0,
      });

      const remainingFlowIds = new Set(listTaskFlowRecords().map((flow) => flow.flowId));
      expect(remainingFlowIds).toEqual(new Set([fresh.flowId, running.flowId]));
    });
  });

  it("expires waiting flows older than 5 minutes", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      const stuckFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Waiting for approval",
        status: "waiting",
        createdAt: now - 6 * 60_000,
        updatedAt: now - 6 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 1,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 1,
      });
      const storedFlow = getTaskFlowById(stuckFlow.flowId);
      if (!storedFlow) {
        throw new Error("Expected expired waiting flow to remain registered");
      }
      expect(storedFlow.flowId).toBe(stuckFlow.flowId);
      expect(storedFlow.status).toBe("lost");
    });
  });

  it("does not expire waiting flows younger than 5 minutes", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Waiting for approval — fresh",
        status: "waiting",
        createdAt: now - 2 * 60_000,
        updatedAt: now - 2 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });
    });
  });

  it("does not expire non-waiting flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Running flow",
        status: "running",
        createdAt: now - 10 * 60_000,
        updatedAt: now - 10 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 0,
      });
    });
  });

  it("expires multiple stuck waiting flows from different sessions", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      for (let index = 0; index < 10; index += 1) {
        createManagedTaskFlow({
          ownerKey: `agent:main:${index}`,
          controllerId: "tests/task-flow-maintenance",
          goal: `Waiting flow ${index}`,
          status: "waiting",
          createdAt: now - 10 * 60_000 - index * 1000,
          updatedAt: now - 10 * 60_000 - index * 1000,
        });
      }

      const freshWaiting = createManagedTaskFlow({
        ownerKey: "agent:main:fresh",
        controllerId: "tests/task-flow-maintenance",
        goal: "Fresh waiting flow",
        status: "waiting",
        createdAt: now - 2 * 60_000,
        updatedAt: now - 2 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 10,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
        expired: 10,
      });

      const storedFreshFlow = getTaskFlowById(freshWaiting.flowId);
      if (!storedFreshFlow) {
        throw new Error("Expected fresh waiting flow to remain registered");
      }
      expect(storedFreshFlow.status).toBe("waiting");
    });
  });
});
