import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetRuntimeTaskTestState } from "../plugins/runtime/runtime-task-test-harness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { createRunningTaskRunCore } from "../tasks/task-executor.js";
import { configureTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import * as workerStore from "./sqlite-worker-store.js";

const ownerKey = "agent:main:managed-child-test";
const childSessionKey = "agent:main:managed-child";
const runId = "managed-child-run";
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-managed-link-", applyEnv: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await resetRuntimeTaskTestState();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
  await state.cleanup();
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
  const original = workerStore.runSqliteWorkerStoreOperation;
  let held = false;
  vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
    <Operations extends SqliteWorkerOperations, T>(
      store: SqliteWorkerStore<Operations>,
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
      stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
      assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
      createAdmission?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[4],
      requireStateLifecycle?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[5],
    ) =>
      original(
        store,
        (scope) =>
          operation({
            execute: async (command, options) => {
              const selected = !held && command.type === commandType;
              if (selected) {
                held = true;
              }
              if (selected && phase === "before execution") {
                ready.resolve();
                await release.promise;
              }
              try {
                const result = await scope.execute(command, options);
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
            },
          }),
        stateContext,
        assertCurrent,
        createAdmission,
        requireStateLifecycle,
      ),
  );
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
