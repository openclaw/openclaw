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

it.each(["creation", "terminal", "delivery", "read"] as const)(
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
              pending = runtime.createRunningTaskRunAsync!({
                runId: "harness:created",
                task: "Worker-created mirror",
                notifyPolicy: "silent",
                deliveryStatus: "not_applicable",
              }).then((created) => {
                observedTaskId = created.taskId;
                return [created];
              });
            } else if (operation === "read") {
              emitAgentEvent({
                runId,
                stream: "lifecycle",
                data: { phase: "end", endedAt: terminal.endedAt },
              });
              pending = runtime.prepareTaskRunRead!(runId).then((read) => read());
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
                status: operation === "creation" ? "running" : "succeeded",
                ...(operation === "delivery" ? { deliveryStatus: "delivered" } : {}),
              },
            ]);
            const snapshot = await getTaskRegistryStore().loadMutationSnapshotAsync(context, {
              taskId: observedTaskId,
            });
            expect(snapshot.tasks.get(observedTaskId)).toMatchObject({
              status: operation === "creation" ? "running" : "succeeded",
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

it.each(["replacement", "retirement"] as const)(
  "never settles a successor after assignment %s while completion is queued",
  async (change) => {
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
          const pending = runtime.finalizeTaskRunByRunIdAsync!({
            runId,
            expectedTask: captureAgentHarnessTaskAssignment(original),
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
            } else {
              await expect(pending).resolves.toEqual([]);
              expect(read()).toMatchObject([{ task: "Successor", status: "running" }]);
            }
            const stored = (await prepareTaskRegistryRead())?.getTaskById(original.taskId);
            expect(stored).toMatchObject({
              status: "running",
              task: change === "replacement" ? "Successor" : "Original",
            });
            expect(getTaskById(original.taskId)).toEqual(stored);
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

it.each(["refused", "unsupported"] as const)(
  "keeps asynchronous exact settlement with a %s custom adapter",
  async (mode) => {
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
        const pending = createRuntime().finalizeTaskRunByRunIdAsync!({
          runId,
          expectedTask: captureAgentHarnessTaskAssignment(task),
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
  },
);
