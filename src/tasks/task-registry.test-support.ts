import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { clearTaskRegistrySqliteForTests } from "../test-utils/task-registry-sqlite.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.test-support.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import type { SubagentAdminKillResult } from "./task-registry-control.types.js";
import { createTaskRecord as createTaskRecordOrNull } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

export { reloadTaskRegistryFromStoreAsync } from "./task-registry-state.js";

export {
  markTaskLostById,
  markTaskTerminalById as finishTaskFixture,
  recordTaskProgressByRunId,
} from "./task-registry.js";

type CreateTaskRecordParams = Parameters<typeof createTaskRecordOrNull>[0];
type TaskFixtureDefaults = "runtime" | "ownerKey" | "scopeKind" | "status" | "deliveryStatus";
type TaskFixtureParams = Omit<CreateTaskRecordParams, TaskFixtureDefaults> &
  Partial<Pick<CreateTaskRecordParams, Exclude<TaskFixtureDefaults, "runtime">>>;

export function createTaskFixture(
  runtime: CreateTaskRecordParams["runtime"],
  params: TaskFixtureParams,
): TaskRecord {
  const task = createTaskRecordOrNull({
    runtime,
    ownerKey: "agent:main:main",
    scopeKind: "session",
    status: "running",
    deliveryStatus: "not_applicable",
    ...params,
  });
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

/** Prepare the native fixture's worker reader before testing publication races. */
export async function prepareTaskFixtureRead(
  task: Pick<TaskRecord, "taskId" | "runId" | "status">,
) {
  const store = getTaskRegistryStore();
  const snapshot = await store.loadMutationSnapshotAsync(captureOpenClawStateWorkerContext(), {
    taskId: task.taskId,
  });
  const persisted = snapshot.tasks.get(task.taskId);
  assert.ok(persisted, "Expected the task fixture to be readable through the worker");
  assert.deepEqual(
    { taskId: persisted.taskId, runId: persisted.runId, status: persisted.status },
    { taskId: task.taskId, runId: task.runId, status: task.status },
  );
  return store;
}

export function createAcpTaskRecord(
  params: Omit<TaskFixtureParams, "task"> & { runId: string; task?: string },
): TaskRecord {
  return createTaskFixture("acp", {
    childSessionKey: "agent:main:acp:child",
    task: "Investigate issue",
    deliveryStatus: "pending",
    ...params,
  });
}

export function createTerminalSubagentKillResult(
  task: TaskRecord,
  terminalState: DetachedTaskTerminalState,
): SubagentAdminKillResult {
  return {
    found: true,
    killed: false,
    runId: expectDefined(task.runId, "expected subagent run id"),
    sessionKey: expectDefined(task.childSessionKey, "expected child session key"),
    cascadeKilled: 0,
    targetState: { state: "terminal", task: terminalState },
  };
}

type TaskRegistryTestApi = {
  maybeDeliverTaskStateChangeUpdate(
    task: TaskRecord,
    latestEvent?: TaskEventRecord,
  ): Promise<TaskRecord | null>;
  resetTaskRegistryForTests(): void;
};

function getTestApi(): TaskRegistryTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskRegistryTestApi")
  ];
  if (!api) {
    throw new Error("task registry test API is unavailable");
  }
  return api as TaskRegistryTestApi;
}

export async function maybeDeliverTaskStateChangeUpdate(
  task: TaskRecord,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  return await getTestApi().maybeDeliverTaskStateChangeUpdate(task, latestEvent);
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }): void {
  getTestApi().resetTaskRegistryForTests();
  if (opts?.persist !== false) {
    clearTaskRegistrySqliteForTests("task");
  }
}

export function configureInMemoryTaskStoresForTests() {
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore(),
  });
  configureTaskFlowRegistryRuntime({
    store: createInMemoryTaskFlowRegistryStore(),
  });
}

export async function withTaskRegistryTempDir<T>(
  run: (root: string) => Promise<T>,
  options?: { durableStore?: boolean },
): Promise<T> {
  return await withTestDir({ prefix: "openclaw-task-registry-" }, async (root) => {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      if (options?.durableStore !== true) {
        configureInMemoryTaskStoresForTests();
      }
      try {
        return await run(root);
      } finally {
        // Drain worker-backed state while the fixture's files and environment still exist.
        try {
          await cleanupSessionStateForTest({ stateDir: root, rootPath: root });
        } finally {
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
        }
      }
    });
  });
}

export async function flushAsyncWork(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

export function createStoredTask(): TaskRecord {
  return {
    taskId: "task-restored",
    runtime: "acp",
    sourceId: "run-restored",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:restored",
    runId: "run-restored",
    task: "Restored task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 100,
  };
}
