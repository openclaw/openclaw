import { afterEach, describe, expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
  isProcessOwnedTaskIdActive,
  registerProcessOwnedTaskId,
} from "./process-owned-task-liveness.js";
import { createRunningTaskRun } from "./task-executor.js";
import { getTaskFlowById, reloadTaskFlowRegistryFromStore } from "./task-flow-registry.js";
import { getTaskById, reloadTaskRegistryFromStore } from "./task-registry.js";
import {
  configureTaskRegistryMaintenance,
  getInspectableActiveTaskRestartBlockers,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetProcessOwnedTaskLivenessForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-runtime.test-helpers.js";

function requireTask(taskId: string): TaskRecord {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`expected task ${taskId}`);
  }
  return task;
}

afterEach(() => {
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetProcessOwnedTaskLivenessForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("process-owned task liveness", () => {
  it("rechecks ownership registered while maintenance yields", async () => {
    await withStateDirEnv("openclaw-process-owned-task-race-", async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });

      const staleAt = Date.now() - 10 * 60_000;
      const created = createRunningTaskRun({
        runtime: "acp",
        taskKind: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        sourceId: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        requesterSessionKey: "agent:main:restart-race",
        ownerKey: "agent:main:restart-race",
        scopeKind: "session",
        runId: "turn-maint:restart-race",
        label: "Context engine turn maintenance",
        task: "Deferred context-engine maintenance after turn.",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      if (!created) {
        throw new Error("expected a process-owned task");
      }

      const maintenance = runTaskRegistryMaintenance();
      const releaseOwner = registerProcessOwnedTaskId(created.taskId);

      expect(await maintenance).toMatchObject({ reconciled: 0 });
      expect(requireTask(created.taskId).status).toBe("running");

      releaseOwner();
    });
  });

  it("reconciles persisted maintenance work after its owning process exits", async () => {
    await withStateDirEnv("openclaw-process-owned-task-", async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      setTaskRegistryDeliveryRuntimeForTests({ sendMessage: vi.fn() });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });

      const staleAt = Date.now() - 10 * 60_000;
      const created = createRunningTaskRun({
        runtime: "acp",
        taskKind: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        sourceId: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        requesterSessionKey: "agent:main:restart-reconciliation",
        ownerKey: "agent:main:restart-reconciliation",
        scopeKind: "session",
        runId: "turn-maint:restart-reconciliation",
        label: "Context engine turn maintenance",
        task: "Deferred context-engine maintenance after turn.",
        notifyPolicy: "silent",
        deliveryStatus: "pending",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      if (!created?.parentFlowId) {
        throw new Error("expected a mirrored task flow");
      }
      const taskId = created.taskId;
      const flowId = created.parentFlowId;
      const releaseOwner = registerProcessOwnedTaskId(taskId);

      expect(isProcessOwnedTaskIdActive(taskId)).toBe(true);
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(requireTask(taskId).status).toBe("running");
      expect(getTaskFlowById(flowId)?.status).toBe("running");
      expect(getInspectableActiveTaskRestartBlockers()).toHaveLength(1);

      reloadTaskRegistryFromStore();
      reloadTaskFlowRegistryFromStore();
      expect(requireTask(taskId).status).toBe("running");
      expect(getTaskFlowById(flowId)?.status).toBe("running");

      // SIGUSR1 keeps this Node process and its queued/running workers alive, so
      // an in-process restart must preserve their process-owned liveness.
      await drainGlobalSingletonLifecycleState("restart");
      expect(isProcessOwnedTaskIdActive(taskId)).toBe(true);

      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(requireTask(taskId).status).toBe("running");
      expect(getTaskFlowById(flowId)?.status).toBe("running");

      // A full process exit drops the in-memory owner set. The close lifecycle
      // models that boundary while retaining durable task and TaskFlow rows.
      await drainGlobalSingletonLifecycleState("close");
      expect(isProcessOwnedTaskIdActive(taskId)).toBe(false);

      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
      const lostTask = requireTask(taskId);
      const lostFlow = getTaskFlowById(flowId);
      expect(lostTask).toMatchObject({
        status: "lost",
        error: "owning process exited",
      });
      expect(lostTask.endedAt).toEqual(expect.any(Number));
      expect(lostTask.lastEventAt).toEqual(expect.any(Number));
      expect(lostTask.cleanupAfter).toEqual(expect.any(Number));
      expect(lostFlow).toMatchObject({
        status: "lost",
        endedAt: lostTask.endedAt,
        updatedAt: lostTask.lastEventAt,
      });
      expect(getInspectableActiveTaskRestartBlockers()).toHaveLength(0);

      reloadTaskRegistryFromStore();
      reloadTaskFlowRegistryFromStore();
      const durableTask = requireTask(taskId);
      const durableFlow = getTaskFlowById(flowId);
      expect(durableTask).toMatchObject({
        status: "lost",
        error: "owning process exited",
        endedAt: lostTask.endedAt,
        lastEventAt: lostTask.lastEventAt,
        cleanupAfter: lostTask.cleanupAfter,
      });
      expect(durableFlow).toMatchObject({
        status: "lost",
        endedAt: lostFlow?.endedAt,
        updatedAt: lostFlow?.updatedAt,
      });

      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(requireTask(taskId)).toMatchObject({
        endedAt: durableTask.endedAt,
        lastEventAt: durableTask.lastEventAt,
        cleanupAfter: durableTask.cleanupAfter,
      });
      expect(getTaskFlowById(flowId)).toMatchObject({
        endedAt: durableFlow?.endedAt,
        updatedAt: durableFlow?.updatedAt,
      });

      releaseOwner();
    });
  });
});
