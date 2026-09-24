import { afterEach, beforeEach, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import * as workerStore from "./sqlite-worker-store.js";

export const taskWorkerOwnerKey = "agent:main:async-reader";

export function taskWorkerRecord(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: taskWorkerOwnerKey,
    ownerKey: taskWorkerOwnerKey,
    scopeKind: "session",
    task: "Synthetic task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    parentFlowId: "flow-a",
    runId: "run-a",
    requesterAgentId: "main",
    ...overrides,
  };
}

export function taskWorkerFlow(
  flowId: string,
  overrides: Partial<TaskFlowRecord> = {},
): TaskFlowRecord {
  return {
    flowId,
    syncMode: "managed",
    controllerId: "tests/async-reads",
    ownerKey: taskWorkerOwnerKey,
    revision: 1,
    status: "running",
    notifyPolicy: "silent",
    goal: "Synthetic flow",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

export function useTaskWorkerState(prefix: string, reset: () => Promise<void>) {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix, applyEnv: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    await reset();
    await state.cleanup();
  });
  return {
    get state() {
      return state;
    },
  };
}

export function interceptTaskWorkerCommands(
  intercept: <Output>(type: PropertyKey, execute: () => Promise<Output>) => Promise<Output>,
) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        ...context: Parameters<typeof original> extends [unknown, unknown, ...infer Rest]
          ? Rest
          : never
      ) =>
        original(
          store,
          (scope) =>
            operation({
              execute: (command, options) =>
                intercept(command.type, () => scope.execute(command, options)),
            }),
          ...context,
        ),
    );
}
