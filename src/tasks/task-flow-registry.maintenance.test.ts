// Covers maintenance reconciliation for managed task-flow records.
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { createRunningTaskRunCore as createRunningTaskRunOrNull } from "./task-executor.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  setFlowWaiting,
} from "./task-flow-registry.js";
import {
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { finalizeTaskRecordByRunId } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  createFlowRecord as createFlowRecordOrNull,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

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
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state.stateDir);
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("task-flow-registry maintenance", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
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
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
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
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
      });
      expect(getTaskFlowById(oldFlow.flowId)).toBeUndefined();
    });
  });

  it.each(["preview", "apply"] as const)(
    "preserves old blocked managed flows without an end timestamp during %s maintenance",
    async (mode) => {
      await withTaskFlowMaintenanceStateDir(async () => {
        const blockedAt = Date.now() - 8 * 24 * 60 * 60_000;
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/task-flow-maintenance",
          goal: "Wait for an external approval",
          status: "running",
          createdAt: blockedAt,
          updatedAt: blockedAt,
        });
        const blocked = setFlowWaiting({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          blockedSummary: "Waiting for an external approval",
          updatedAt: blockedAt,
        });
        expect(blocked.applied).toBe(true);
        expect(getInspectableTaskFlowAuditSummary().byCode.stale_blocked).toBe(1);

        const maintenance =
          mode === "preview"
            ? previewTaskFlowRegistryMaintenance()
            : await runTaskFlowRegistryMaintenance();

        expect(getTaskFlowById(flow.flowId)).toMatchObject({
          status: "blocked",
          blockedSummary: "Waiting for an external approval",
          updatedAt: blockedAt,
        });
        expect(getTaskFlowById(flow.flowId)?.endedAt).toBeUndefined();
        expect(maintenance).toEqual({ reconciled: 0, pruned: 0 });
        expect(getInspectableTaskFlowAuditSummary().byCode.stale_blocked).toBe(1);
      });
    },
  );

  it("prunes ended blocked flows without removing resumable managed flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const endedAt = Date.now() - 8 * 24 * 60 * 60_000;
      const endedManaged = createManagedTaskFlow({
        ownerKey: "agent:main:ended-managed",
        controllerId: "tests/task-flow-maintenance",
        goal: "Completed managed flow",
        status: "blocked",
        blockedSummary: "Completed with a blocked result",
        createdAt: endedAt,
        updatedAt: endedAt,
        endedAt,
      });
      const endedMirrored = createFlowRecord({
        syncMode: "task_mirrored",
        ownerKey: "agent:main:ended-mirrored",
        goal: "Completed mirrored flow",
        status: "blocked",
        blockedSummary: "Completed with a blocked result",
        createdAt: endedAt,
        updatedAt: endedAt,
        endedAt,
      });
      const activeManaged = createManagedTaskFlow({
        ownerKey: "agent:main:active-managed",
        controllerId: "tests/task-flow-maintenance",
        goal: "Resume after approval",
        status: "blocked",
        blockedSummary: "Waiting for an external approval",
        createdAt: endedAt,
        updatedAt: endedAt,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 2 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 2 });
      expect(getTaskFlowById(endedManaged.flowId)).toBeUndefined();
      expect(getTaskFlowById(endedMirrored.flowId)).toBeUndefined();
      expect(getTaskFlowById(activeManaged.flowId)).toMatchObject({ status: "blocked" });
    });
  });

  it("finalizes cancel-requested blocked managed flows without active child tasks", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Cancel blocked work",
        status: "running",
      });
      const blocked = setFlowWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        blockedSummary: "Waiting for an external approval",
      });
      if (!blocked.applied) {
        throw new Error("Expected managed flow to enter its resumable blocked state");
      }
      const cancelled = requestFlowCancel({
        flowId: flow.flowId,
        expectedRevision: blocked.flow.revision,
      });
      expect(cancelled.applied).toBe(true);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 1, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 1, pruned: 0 });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({ status: "cancelled" });
      expect(getTaskFlowById(flow.flowId)?.endedAt).toBeTypeOf("number");
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
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
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

  it("reconciles a flow gated on a child task that no longer exists", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const blockedAt = Date.now() - 60 * 60_000;
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait on a child task that vanished",
        status: "running",
        createdAt: blockedAt,
        updatedAt: blockedAt,
      });
      const blocked = setFlowWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        blockedTaskId: "task-vanished",
        blockedSummary: "Waiting for child task",
        updatedAt: blockedAt,
      });
      expect(blocked.applied).toBe(true);
      expect(getInspectableTaskFlowAuditSummary().byCode.blocked_task_missing).toBe(1);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 1, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 1, pruned: 0 });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "lost",
        blockedTaskId: undefined,
        blockedSummary: undefined,
      });
      expect(getTaskFlowById(flow.flowId)?.endedAt).toBeTypeOf("number");
      expect(getInspectableTaskFlowAuditSummary().byCode.blocked_task_missing).toBe(0);
    });
  });

  it("keeps flows blocked on an existing child task or inside the dangling grace window", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const staleAt = Date.now() - 60 * 60_000;
      const linkedFlow = createManagedTaskFlow({
        ownerKey: "agent:main:linked",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait on a live child task",
        status: "running",
        createdAt: staleAt,
        updatedAt: staleAt,
      });
      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:linked",
        scopeKind: "session",
        parentFlowId: linkedFlow.flowId,
        childSessionKey: "agent:main:linked:child",
        runId: "run-live-child",
        task: "Inspect repo",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      expect(
        setFlowWaiting({
          flowId: linkedFlow.flowId,
          expectedRevision: linkedFlow.revision,
          blockedTaskId: child.taskId,
          updatedAt: staleAt,
        }).applied,
      ).toBe(true);

      const freshFlow = createManagedTaskFlow({
        ownerKey: "agent:main:fresh",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait on a child task registered moments ago",
        status: "running",
        createdAt: staleAt,
        updatedAt: staleAt,
      });
      expect(
        setFlowWaiting({
          flowId: freshFlow.flowId,
          expectedRevision: freshFlow.revision,
          blockedTaskId: "task-pending-registration",
          updatedAt: Date.now(),
        }).applied,
      ).toBe(true);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(linkedFlow.flowId)).toMatchObject({
        status: "blocked",
        blockedTaskId: child.taskId,
      });
      expect(getTaskFlowById(freshFlow.flowId)).toMatchObject({
        status: "blocked",
        blockedTaskId: "task-pending-registration",
      });
    });
  });

  it("preserves dangling-blocker flows while a sibling child is still unsettled", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const staleAt = Date.now() - 60 * 60_000;
      const activeFlow = createManagedTaskFlow({
        ownerKey: "agent:main:active-sibling",
        controllerId: "tests/task-flow-maintenance",
        goal: "Missing blocker with a running sibling",
        status: "running",
        createdAt: staleAt,
        updatedAt: staleAt,
      });
      createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:active-sibling",
        scopeKind: "session",
        parentFlowId: activeFlow.flowId,
        childSessionKey: "agent:main:active-sibling:child",
        runId: "run-dangling-active-sibling",
        task: "Still running",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      expect(
        setFlowWaiting({
          flowId: activeFlow.flowId,
          expectedRevision: activeFlow.revision,
          blockedTaskId: "task-vanished",
          blockedSummary: "Waiting for child task",
          updatedAt: staleAt,
        }).applied,
      ).toBe(true);

      const provisionalFlow = createManagedTaskFlow({
        ownerKey: "agent:main:provisional-sibling",
        controllerId: "tests/task-flow-maintenance",
        goal: "Missing blocker with a provisional kill sibling",
        status: "running",
        createdAt: staleAt,
        updatedAt: staleAt,
      });
      const provisionalChild = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:provisional-sibling",
        scopeKind: "session",
        parentFlowId: provisionalFlow.flowId,
        childSessionKey: "agent:main:provisional-sibling:child",
        runId: "run-dangling-provisional-sibling",
        task: "Kill racing",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      finalizeTaskRecordByRunId({
        runId: provisionalChild.runId!,
        runtime: "subagent",
        sessionKey: provisionalChild.childSessionKey,
        status: "cancelled",
        endedAt: staleAt + 1,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      expect(
        setFlowWaiting({
          flowId: provisionalFlow.flowId,
          expectedRevision: provisionalFlow.revision,
          blockedTaskId: "task-vanished",
          blockedSummary: "Waiting for child task",
          updatedAt: staleAt,
        }).applied,
      ).toBe(true);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(activeFlow.flowId)).toMatchObject({
        status: "blocked",
        blockedTaskId: "task-vanished",
      });
      expect(getTaskFlowById(provisionalFlow.flowId)).toMatchObject({
        status: "blocked",
        blockedTaskId: "task-vanished",
      });
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
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 0,
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

  it("does not finalize cancel-requested flows while a child kill is provisional", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Wait for child kill reconciliation",
        status: "running",
        createdAt: 1,
        updatedAt: 100,
      });
      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:provisional-kill",
        runId: "run-provisional-kill",
        task: "Finish while cancellation races",
        startedAt: 100,
        lastEventAt: 100,
      });
      finalizeTaskRecordByRunId({
        runId: child.runId!,
        runtime: "subagent",
        sessionKey: child.childSessionKey,
        status: "cancelled",
        endedAt: 110,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      const currentFlow = getTaskFlowById(flow.flowId);
      if (!currentFlow) {
        throw new Error("Expected provisional child flow to remain registered");
      }
      const cancelResult = requestFlowCancel({
        flowId: currentFlow.flowId,
        expectedRevision: currentFlow.revision,
        cancelRequestedAt: 120,
        updatedAt: 120,
      });
      expect(cancelResult.applied).toBe(true);

      expect(previewTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(await runTaskFlowRegistryMaintenance()).toEqual({ reconciled: 0, pruned: 0 });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "running",
        cancelRequestedAt: 120,
      });
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
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 25,
      });

      const remainingFlowIds = new Set(listTaskFlowRecords().map((flow) => flow.flowId));
      expect(remainingFlowIds).toEqual(new Set([fresh.flowId, running.flowId]));
    });
  });
});
