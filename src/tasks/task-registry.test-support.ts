import { expectDefined } from "@openclaw/normalization-core";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearTaskRegistrySqliteForTests } from "../test-utils/task-registry-sqlite.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.test-support.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import type {
  SubagentAdminKillResult,
  TaskRegistryControlRuntime,
} from "./task-registry-control.types.js";
import type { TaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";
import { createTaskRecord as createTaskRecordOrNull } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
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
    taskId: string,
    latestEvent?: TaskEventRecord,
  ): Promise<TaskRecord | null>;
  resetTaskRegistryForTests(): void;
  resetTaskRegistryDeliveryRuntimeForTests(): void;
  setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void;
  resetTaskRegistryControlRuntimeForTests(): void;
  setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void;
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
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  return await getTestApi().maybeDeliverTaskStateChangeUpdate(taskId, latestEvent);
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }): void {
  getTestApi().resetTaskRegistryForTests();
  if (opts?.persist !== false) {
    clearTaskRegistrySqliteForTests("task");
  }
}

export function resetTaskRegistryDeliveryRuntimeForTests(): void {
  getTestApi().resetTaskRegistryDeliveryRuntimeForTests();
}

export function setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void {
  getTestApi().setTaskRegistryDeliveryRuntimeForTests(runtime);
}

export function resetTaskRegistryControlRuntimeForTests(): void {
  getTestApi().resetTaskRegistryControlRuntimeForTests();
}

export function setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void {
  getTestApi().setTaskRegistryControlRuntimeForTests(runtime);
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
        // Close both sqlite-backed registries before Windows temp-dir cleanup tries to remove them.
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    });
  });
}
