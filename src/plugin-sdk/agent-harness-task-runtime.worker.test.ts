import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { getTaskById } from "../tasks/task-registry-query.js";
import { prepareTaskRegistryRead } from "../tasks/task-registry-read.js";
import { transitionTaskRecordsByRunNative } from "../tasks/task-registry-transition.native.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import {
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskRuntime,
} from "./agent-harness-task-runtime.js";

const runId = "harness:private-completion";
const requesterSessionKey = "agent:main:subagent:private-parent";
function createRuntime() {
  return createAgentHarnessTaskRuntime({
    runtime: "cli",
    taskKind: "test-harness",
    scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey }),
    runIdPrefix: "harness:",
  });
}

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
});

it.each([true, false])(
  "requires a core projection for custom harness reads (projected: %s)",
  async (projected) => {
    await withOpenClawTestState({ layout: "split" }, async () => {
      const core = getDetachedTaskLifecycleRuntime();
      let externalTask: TaskRecord | undefined;
      setDetachedTaskLifecycleRuntime({
        ...core,
        createRunningTaskRun(params) {
          if (projected) {
            return core.createRunningTaskRun(params);
          }
          externalTask = {
            runtime: params.runtime,
            taskKind: params.taskKind,
            runId: params.runId,
            task: params.task,
            requesterSessionKey,
            ownerKey: requesterSessionKey,
            scopeKind: "session",
            taskId: "adapter-only-task",
            status: "running",
            notifyPolicy: "silent",
            deliveryStatus: "not_applicable",
            createdAt: 1,
          };
          return externalTask;
        },
        findTaskRun(params) {
          return externalTask?.childSessionKey === params.sessionKey
            ? externalTask
            : core.findTaskRun?.(params);
        },
        transitionTaskAssignment(params) {
          return transitionTaskRecordsByRunNative(params.transition, params);
        },
      });
      try {
        const runtime = createRuntime();
        runtime.assertTaskAssignmentSupported();
        const created = await runtime.createRunningTaskRunAsync!({ runId, task: "Adapter-owned" });
        expect(created.childSessionKey).toBeUndefined();
        const read = await runtime.prepareTaskRunRead!(runId);
        if (!projected) {
          expect(read).toThrow("no prepared core projection");
          expect(externalTask?.status).toBe("running");
          return;
        }
        expect(read()).toEqual([created]);
        await expect(
          runtime.finalizeTaskRunByRunIdAsync!({
            runId,
            expectedTask: captureAgentHarnessTaskAssignment(created),
            status: "succeeded",
            endedAt: created.createdAt + 1,
            suppressDelivery: true,
          }),
        ).resolves.toMatchObject([{ taskId: created.taskId, status: "succeeded" }]);
        expect(read()).toMatchObject([{ taskId: created.taskId, status: "succeeded" }]);
        resetDetachedTaskLifecycleRuntimeForTests();
        expect(read).toThrow("owner changed");
      } finally {
        resetDetachedTaskLifecycleRuntimeForTests();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it.each(["creation", "progress", "terminal", "delivery", "read", "recovery"] as const)(
  "keeps the event loop progressing through contended harness %s persistence",
  async (operation) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      await withStateDatabaseCoordinatorRuntimeDirectory(
        { directory: state.path("coordinators"), keepAlive: false },
        async () => {
          expect(process.env.HOME).toBe(state.home);
          expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
          const runtime = createRuntime();
          const task = runtime.createRunningTaskRun({
            runId,
            task: "Private completion",
            notifyPolicy: "silent",
          });
          const expectedTask = captureAgentHarnessTaskAssignment(task);
          const terminal = {
            runId,
            expectedTask,
            status: "succeeded" as const,
            endedAt: task.createdAt + 1,
            suppressDelivery: true,
          };
          if (operation === "delivery") {
            await runtime.finalizeTaskRunByRunIdAsync!(terminal);
          }
          await runtime.prepareTaskRunRead!(runId);
          const context = captureOpenClawStateWorkerContext();
          expect(context.admission.databasePath.startsWith(state.stateDir)).toBe(true);
          expect(context.coordinatorRuntime.directory.startsWith(state.root)).toBe(true);
          const holder = holdStateDatabaseCoordinator(
            context.admission.databasePath,
            context.coordinatorRuntime,
            1000,
          );
          let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
          let observedTaskId = task.taskId;
          try {
            await holder.ready;
            const heartbeat = nextTurn().then(() => Atomics.load(holder.released, 0));
            let pending: Promise<unknown>;
            if (operation === "creation") {
              pending = runtime.tryCreateRunningTaskRunAsync!({
                runId: "harness:created",
                task: "Worker-created mirror",
                notifyPolicy: "silent",
                deliveryStatus: "not_applicable",
              }).then((created) => {
                if (!created) {
                  throw new Error("Core task creation unexpectedly refused");
                }
                observedTaskId = created.taskId;
                return [created];
              });
            } else if (operation === "progress") {
              pending = runtime.recordTaskRunProgressByRunIdAsync!({
                runId,
                expectedTask,
                progressSummary: "Native child is working",
                lastEventAt: task.createdAt + 1,
              });
            } else if (operation === "read" || operation === "recovery") {
              emitAgentEvent({
                runId,
                stream: "lifecycle",
                data: { phase: "end", endedAt: terminal.endedAt },
              });
              pending = (
                operation === "read"
                  ? runtime.prepareTaskRunRead!(runId)
                  : runtime.prepareTaskRecordsRead!()
              ).then((read) => read());
            } else if (operation === "terminal") {
              pending = runtime.finalizeTaskRunByRunIdAsync!(terminal);
            } else {
              pending = runtime.setDetachedTaskDeliveryStatusByRunIdAsync!({
                runId,
                expectedTask,
                deliveryStatus: "delivered",
              });
            }
            settled = Promise.allSettled([pending]);
            expect(await heartbeat, "heartbeat must run before the holder releases").toBe(0);
            holder.release();
            expect(await pending).toMatchObject([
              {
                taskId: observedTaskId,
                status:
                  operation === "creation" || operation === "progress" ? "running" : "succeeded",
                ...(operation === "progress" ? { progressSummary: "Native child is working" } : {}),
                ...(operation === "delivery" ? { deliveryStatus: "delivered" } : {}),
              },
            ]);
            const snapshot = await getTaskRegistryStore().loadMutationSnapshotAsync(context, {
              taskId: observedTaskId,
            });
            expect(snapshot.tasks.get(observedTaskId)).toMatchObject({
              status:
                operation === "creation" || operation === "progress" ? "running" : "succeeded",
              ...(operation === "progress" ? { progressSummary: "Native child is working" } : {}),
              ...(operation === "delivery" ? { deliveryStatus: "delivered" } : {}),
            });
          } finally {
            holder.release();
            await holder.joined;
            await settled;
            await closeOpenClawStateDatabaseAsync();
          }
        },
      );
    });
  },
);

it.each([
  ["replacement", "terminal"],
  ["retirement", "terminal"],
  ["replacement", "progress"],
  ["retirement", "progress"],
] as const)(
  "never mutates a successor after assignment %s while %s is queued",
  async (change, operation) => {
    await withOpenClawTestState({ layout: "split" }, async () => {
      const registry = createEmptyPluginRegistry();
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          const runtime = createRuntime();
          const original = runtime.createRunningTaskRun({
            runId,
            task: "Original",
            notifyPolicy: "silent",
          });
          const read = await runtime.prepareTaskRunRead!(runId);
          const recovery = await runtime.prepareTaskRecordsRead!();
          const params = {
            runId,
            expectedTask: captureAgentHarnessTaskAssignment(original),
          };
          const pending =
            operation === "progress"
              ? runtime.recordTaskRunProgressByRunIdAsync!({
                  ...params,
                  progressSummary: "Original progress",
                  lastEventAt: original.createdAt + 2,
                })
              : runtime.finalizeTaskRunByRunIdAsync!({
                  ...params,
                  status: "succeeded",
                  endedAt: original.createdAt + 1,
                  suppressDelivery: true,
                });
          const settled = Promise.allSettled([pending]);
          if (change === "retirement") {
            markPluginRegistryRetired(registry);
          } else {
            const successor = updateTask(original.taskId, {
              createdAt: original.createdAt + 1,
              startedAt: original.createdAt + 1,
              lastEventAt: original.createdAt + 1,
              task: "Successor",
            });
            expect(successor?.createdAt).toBe(original.createdAt + 1);
          }
          try {
            if (change === "retirement") {
              await expect(pending).rejects.toThrow("owner changed");
              expect(read).toThrow("owner changed");
              expect(recovery).toThrow("owner changed");
            } else {
              await expect(pending).resolves.toEqual([]);
              expect(read()).toMatchObject([{ task: "Successor", status: "running" }]);
              expect(recovery()).toMatchObject([{ task: "Successor", status: "running" }]);
            }
            const stored = (await prepareTaskRegistryRead())?.getTaskById(original.taskId);
            expect(stored).toMatchObject({
              status: "running",
              task: change === "replacement" ? "Successor" : "Original",
            });
            expect(getTaskById(original.taskId)).toEqual(stored);
            expect(stored?.progressSummary).not.toBe("Original progress");
          } finally {
            await settled;
          }
        });
      } finally {
        markPluginRegistryRetired(registry);
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it.each([
  ["refused", "terminal"],
  ["unsupported", "terminal"],
  ["refused", "progress"],
  ["unsupported", "progress"],
] as const)("keeps asynchronous exact %s adapter behavior for %s", async (mode, operation) => {
  await withOpenClawTestState({ layout: "split" }, async () => {
    const task = createRuntime().createRunningTaskRun({
      runId,
      task: "Adapter-owned",
      notifyPolicy: "silent",
    });
    const failure = new Error("Custom adapter refused settlement");
    let observedAssignment: string | undefined;
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      ...(mode === "refused"
        ? {
            transitionTaskAssignment(params) {
              params.assertCurrent();
              observedAssignment = params.expectedTask.taskId;
              throw failure;
            },
          }
        : {}),
    });
    try {
      const runtime = createRuntime();
      const params = {
        runId,
        expectedTask: captureAgentHarnessTaskAssignment(task),
      };
      const pending =
        operation === "progress"
          ? runtime.recordTaskRunProgressByRunIdAsync!({
              ...params,
              progressSummary: "Adapter progress",
              lastEventAt: task.createdAt + 1,
            })
          : runtime.finalizeTaskRunByRunIdAsync!({
              ...params,
              status: "succeeded",
              endedAt: task.createdAt + 1,
              suppressDelivery: true,
            });
      if (mode === "refused") {
        await expect(pending).rejects.toBe(failure);
        expect(observedAssignment).toBe(task.taskId);
      } else {
        await expect(pending).rejects.toThrow("Upgrade the custom task runtime adapter");
      }
      const stored = await getTaskRegistryStore().loadMutationSnapshotAsync(
        captureOpenClawStateWorkerContext(),
        { taskId: task.taskId },
      );
      expect(stored.tasks.get(task.taskId)).toMatchObject({
        status: "running",
        task: "Adapter-owned",
      });
    } finally {
      resetDetachedTaskLifecycleRuntimeForTests();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("preserves custom creation refusal and legacy progress without writing core rows", async () => {
  await withOpenClawTestState({ layout: "split" }, async () => {
    const ownerKey = "agent:main:subagent:incognito-private-parent";
    let observedCreation: unknown;
    let observedProgress: unknown;
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      createRunningTaskRun(params) {
        observedCreation = params;
        return null;
      },
      recordTaskRunProgressByRunId(params) {
        observedProgress = params;
        return [];
      },
    });
    try {
      const runtime = createAgentHarnessTaskRuntime({
        runtime: "cli",
        taskKind: "test-harness",
        scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
        runIdPrefix: "harness:",
      });
      await expect(
        runtime.tryCreateRunningTaskRunAsync!({ runId, task: "Private child request" }),
      ).resolves.toBeNull();
      await expect(
        runtime.createRunningTaskRunAsync!({ runId, task: "Private child request" }),
      ).rejects.toThrow("Task persistence failed");
      expect(observedCreation).toMatchObject({
        runtime: "cli",
        taskKind: "test-harness",
        requesterSessionKey: ownerKey,
        ownerKey,
        scopeKind: "session",
        task: "Incognito task",
      });
      await expect(
        runtime.recordTaskRunProgressByRunIdAsync!({
          runId,
          progressSummary: "Private progress",
          eventSummary: "Private event",
        }),
      ).resolves.toEqual([]);
      expect(observedProgress).toMatchObject({
        runId,
        runtime: "cli",
        sessionKey: ownerKey,
        progressSummary: null,
        eventSummary: null,
      });
      expect((await runtime.prepareTaskRecordsRead!())()).toEqual([]);
      resetDetachedTaskLifecycleRuntimeForTests();
      await expect(
        runtime.tryCreateRunningTaskRunAsync!({ runId, task: "Retired request" }),
      ).rejects.toThrow("owner changed");
    } finally {
      resetDetachedTaskLifecycleRuntimeForTests();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("prepares only recovery candidates belonging to the captured harness scope", async () => {
  await withOpenClawTestState({ layout: "split" }, async () => {
    try {
      const runtime = createRuntime();
      const selected = await runtime.tryCreateRunningTaskRunAsync!({ runId, task: "Recover me" });
      for (const overrides of [
        { requesterSessionKey: "agent:main:subagent:other-parent" },
        { runtime: "subagent" as const },
        { taskKind: "other-harness" },
        { runIdPrefix: "other:" },
      ]) {
        const other = createAgentHarnessTaskRuntime({
          runtime: overrides.runtime ?? "cli",
          taskKind: overrides.taskKind ?? "test-harness",
          scope: createAgentHarnessTaskRuntimeScope({
            requesterSessionKey: overrides.requesterSessionKey ?? requesterSessionKey,
          }),
          runIdPrefix: overrides.runIdPrefix ?? "harness:",
        });
        await other.createRunningTaskRunAsync!({
          runId: `${overrides.runIdPrefix ?? "harness:"}unrelated-${Object.keys(overrides)[0]}`,
          task: "Outside recovery scope",
        });
      }
      const read = await runtime.prepareTaskRecordsRead!();
      expect(read()).toEqual([selected]);
      await closeOpenClawStateDatabaseAsync();
      expect(read).toThrow();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
