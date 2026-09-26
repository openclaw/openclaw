// Covers retained sessions_yield diagnostics for audit, maintenance, and drain.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCanonicalTaskActivation } from "./task-backing-authority-write.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import { createRunningTaskRun, withTaskExecutorStateDir } from "./task-executor.test-support.js";
import { tasks } from "./task-registry-state.js";
import {
  getInspectableActiveTaskRestartBlockers,
  getTaskRegistryMaintenanceDiagnostics,
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  createTaskRegistryMaintenanceHarness,
  resetTaskRegistryMaintenanceMocks,
} from "./task-registry.maintenance.test-support.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import { formatActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import { isRetainedYieldOwner, RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "./task-runtime.test-helpers.js";

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const staleAt = Date.now() - 45 * 60_000;
  return {
    taskId: "task-test",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "test task",
    status: "running",
    deliveryStatus: "delivered",
    notifyPolicy: "silent",
    createdAt: staleAt,
    startedAt: staleAt,
    lastEventAt: staleAt,
    ...overrides,
  };
}

afterEach(async () => {
  await stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
});

describe("retained sessions_yield guidance", () => {
  it("explains a retained yield owner without cancelling it", async () => {
    const yieldChild = "agent:main:subagent:yield-owner";
    const liveChild = "agent:main:subagent:live-owner";
    const yielded = makeStaleTask({
      taskId: "task-yield-owner",
      runId: "run-yield-owner",
      childSessionKey: yieldChild,
      lastToolName: "sessions_yield",
    });
    const live = makeStaleTask({
      taskId: "task-live-owner",
      runId: "run-live-owner",
      childSessionKey: liveChild,
      lastToolName: "read",
    });
    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [yielded, live],
      sessionStore: {
        [yieldChild]: { sessionId: "yield-owner", updatedAt: Date.now() },
        [liveChild]: { sessionId: "live-owner", updatedAt: Date.now() },
      },
    });

    expect(previewTaskRegistryMaintenance().reconciled).toBe(0);
    const diagnostics = getTaskRegistryMaintenanceDiagnostics().staleRunningTasks;
    expect(diagnostics.find((diagnostic) => diagnostic.taskId === yielded.taskId)).toMatchObject({
      decision: "retained",
      reason: "backing_session_present",
      detail: RETAINED_YIELD_GUIDANCE,
    });
    expect(
      diagnostics.find((diagnostic) => diagnostic.taskId === live.taskId)?.detail,
    ).toBeUndefined();
    const blockers = getInspectableActiveTaskRestartBlockers();
    const yieldBlocker = expectDefined(
      blockers.find((blocker) => blocker.taskId === yielded.taskId),
      "retained yield restart blocker",
    );
    const liveBlocker = expectDefined(
      blockers.find((blocker) => blocker.taskId === live.taskId),
      "live task restart blocker",
    );
    expect(yieldBlocker.retainedYield).toBe("sessions_yield");
    expect(liveBlocker.retainedYield).toBeUndefined();
    expect(formatActiveTaskRestartBlocker(yieldBlocker)).toContain(
      `lastTool=sessions_yield unverified. ${RETAINED_YIELD_GUIDANCE}`,
    );
    expect(formatActiveTaskRestartBlocker(yieldBlocker)).not.toContain("retained yield owner");
    expect(formatActiveTaskRestartBlocker(liveBlocker)).not.toContain("sessions_yield");
    expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
    expect(currentTasks.get(yielded.taskId)?.status).toBe("running");
    expect(currentTasks.get(live.taskId)?.status).toBe("running");
  });

  it("does not label a resumed generation that still had sessions_yield as its previous tool", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:resumed-yield",
        runId: "resumed-yield-run",
        task: "Resume after yield",
        startedAt: 1,
        lastEventAt: 1,
      });
      const stored = expectDefined(tasks.get(created.taskId), "mirrored running task");
      expectDefined(stored.parentFlowId || undefined, "mirrored task parent flow");
      const childSessionKey = expectDefined(
        stored.childSessionKey || undefined,
        "mirrored child session",
      );
      const runId = expectDefined(stored.runId || undefined, "mirrored run");
      stored.lastToolName = "sessions_yield";
      getTaskRegistryStore().upsertTaskWithDeliveryState({ task: stored });
      const persisted = expectDefined(
        loadTaskRegistryStateFromSqliteReadOnly().tasks.get(stored.taskId),
        "persisted yield task",
      );
      expect(persisted.lastToolName).toBe("sessions_yield");
      expect(isRetainedYieldOwner(persisted)).toBe(true);

      const prepared = expectDefined(
        prepareCanonicalTaskActivation({
          runtime: "subagent",
          childSessionKey,
          runId,
          detail: createSubagentTaskBackingDetail(2),
          startedAt: 2,
        }),
        "canonical task activation",
      );
      expect(prepared.current.lastToolName).toBe("sessions_yield");
      getTaskRegistryStore().upsertTaskWithDeliveryState({ task: prepared.next });
      const resumed = expectDefined(
        loadTaskRegistryStateFromSqliteReadOnly().tasks.get(stored.taskId),
        "persisted resumed task",
      );
      expect(resumed.status).toBe("running");
      expect(resumed.endedAt).toBeUndefined();
      expect(resumed.lastToolName).toBeUndefined();
      expect(isRetainedYieldOwner(resumed)).toBe(false);
    });
  });
});
