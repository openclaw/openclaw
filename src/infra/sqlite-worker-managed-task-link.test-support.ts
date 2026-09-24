import { expect, vi } from "vitest";
import { resetRuntimeTaskTestState } from "../plugins/runtime/runtime-task-test-harness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createRunningTaskRunCore } from "../tasks/task-executor.js";
import { configureTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  interceptTaskWorkerCommands,
  useTaskWorkerState,
} from "./sqlite-worker-task.test-support.js";

const ownerKey = "agent:main:managed-child-test";
const childSessionKey = "agent:main:managed-child";
const runId = "managed-child-run";
useTaskWorkerState("openclaw-managed-link-", async () => {
  await resetRuntimeTaskTestState();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
});

function createBacking(overrides: Partial<Parameters<typeof createRunningTaskRunCore>[0]> = {}) {
  const task = createRunningTaskRunCore({
    runtime: "acp",
    ownerKey,
    scopeKind: "session",
    childSessionKey,
    runId,
    task: "Canonical child work",
    notifyPolicy: "silent",
    deliveryStatus: "pending",
    startedAt: 100,
    detail: {
      kind: "task_backing_instance",
      runtime: "acp",
      instanceId: "instance-1",
      generation: 1,
    },
    ...overrides,
  });
  expect(task?.parentFlowId).toBeTruthy();
  return task!;
}

function holdTaskCreationCommand(
  commandType: "flows.runTask" | "tasks.createRecord",
  phase: "before execution" | "after commit" | "after rejection",
) {
  const ready = createDeferredCore();
  const release = createDeferredCore();
  let held = false;
  interceptTaskWorkerCommands(async (type, execute) => {
    const selected = !held && type === commandType;
    if (selected) {
      held = true;
    }
    if (selected && phase === "before execution") {
      ready.resolve();
      await release.promise;
    }
    try {
      const result = await execute();
      if (selected && phase === "after commit") {
        ready.resolve();
        await release.promise;
      }
      return result;
    } catch (error) {
      if (selected && phase === "after rejection") {
        ready.resolve();
        await release.promise;
      }
      throw error;
    }
  });
  return { ready: ready.promise, release: () => release.resolve() };
}

function holdTaskEventPublication(taskId: string) {
  const ready = createDeferredCore();
  const release = createDeferredCore();
  const store = getTaskRegistryStore();
  const mutate = store.runAgentEventMutationAsync.bind(store);
  vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
    try {
      const receipt = await mutate(...args);
      if (args[1].taskId === taskId) {
        ready.resolve();
        await release.promise;
      }
      return receipt;
    } catch (error) {
      ready.reject(error);
      throw error;
    }
  });
  return { ready: ready.promise, release: () => release.resolve() };
}

export {
  ownerKey,
  childSessionKey,
  runId,
  createBacking,
  holdTaskCreationCommand,
  holdTaskEventPublication,
};
