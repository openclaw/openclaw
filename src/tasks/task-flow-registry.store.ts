// Stores managed task-flow records and stages their process-local projection.
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  cloneFlowRecord,
  areTaskFlowRecordsEqual,
  normalizeRestoredFlowRecord,
  type TaskFlowSyncInput,
} from "./task-flow-registry.records.js";
import {
  closeTaskFlowRegistryDatabase,
  deleteTaskFlowRegistryRecordFromSqlite,
  loadTaskFlowRegistryStateFromSqlite,
  syncTaskMirroredFlowInSqlite,
  updateTaskFlowRegistryRecordInSqlite,
  upsertTaskFlowRegistryRecordToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type {
  TaskFlowRegistryMirroredSync,
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdatePublication,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

type TaskFlowRegistryStore = {
  withSnapshotAsync<T>(
    context: OpenClawStateWorkerContext,
    consume: (snapshot: TaskFlowRegistryStoreSnapshot) => T,
  ): Promise<T>;
  readFlowAsync(
    context: OpenClawStateWorkerContext,
    flowId: string,
  ): Promise<TaskFlowRecord | undefined>;
  loadSnapshot: (flowIds?: readonly string[]) => TaskFlowRegistryStoreSnapshot;
  upsertFlow: (flow: TaskFlowRecord) => void;
  syncMirroredTask: (
    task: TaskFlowSyncInput,
    preparePublication: (result: TaskFlowRegistryMirroredSync) => TaskFlowRegistryUpdatePublication,
  ) => TaskFlowRegistryMirroredSync;
  updateFlow: (
    params: TaskFlowRegistryUpdate,
    preparePublication: (
      update: TaskFlowRegistryObservedUpdate,
    ) => TaskFlowRegistryUpdatePublication,
  ) => TaskFlowRegistryUpdateResult;
  deleteFlow: (flowId: string) => void;
  close?: () => void;
};

const log = createSubsystemLogger("tasks/task-flow-registry");

const defaultFlowRegistryStore: TaskFlowRegistryStore = {
  async withSnapshotAsync(context, consume) {
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return runOpenClawStateWorkerOperation(context, async (scope) => {
      const snapshot = await scope.execute({ type: "flows.snapshot", input: undefined });
      context.admission.assertCurrent();
      return consume(snapshot);
    });
  },
  async readFlowAsync(context, flowId) {
    const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
    return executeOpenClawStateWorker(context, { type: "flows.current", input: { flowId } });
  },
  loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
  upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
  syncMirroredTask: syncTaskMirroredFlowInSqlite,
  updateFlow: updateTaskFlowRegistryRecordInSqlite,
  deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
  close: closeTaskFlowRegistryDatabase,
};

let configuredFlowRegistryStore: TaskFlowRegistryStore = defaultFlowRegistryStore;

export function getTaskFlowRegistryStore(): TaskFlowRegistryStore {
  return configuredFlowRegistryStore;
}

function configureTaskFlowRegistryRuntime(params: { store?: TaskFlowRegistryStore }) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
}

export function resetTaskFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
}

export function prepareTaskFlowRecordPublication(params: {
  cached: TaskFlowRecord | undefined;
  current: TaskFlowRecord | undefined;
  applied: boolean;
  write: (flow: TaskFlowRecord | undefined) => void;
  advance: () => void;
  onCommitted: () => void;
}): TaskFlowRegistryUpdatePublication {
  const { cached, current, applied, write, advance, onCommitted } = params;
  const canonical = current ? cloneFlowRecord(current) : undefined;
  const changed =
    applied ||
    !areTaskFlowRecordsEqual(cached ? normalizeRestoredFlowRecord(cached) : undefined, canonical);
  const next = changed ? canonical : cached;
  return {
    stage: () => {
      advance();
      write(next);
    },
    rollback: () => {
      advance();
      write(cached);
    },
    commit: () => {
      onCommitted();
      advance();
    },
  };
}

export function tryPersistFlowUpsert(flow: TaskFlowRecord, operation: string): boolean {
  try {
    getTaskFlowRegistryStore().upsertFlow(cloneFlowRecord(flow));
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry upsert", {
      operation,
      flowId: flow.flowId,
      error,
    });
    return false;
  }
}

export function tryPersistFlowDelete(flowId: string): boolean {
  try {
    getTaskFlowRegistryStore().deleteFlow(flowId);
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry delete", {
      flowId,
      error,
    });
    return false;
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskFlowRegistryStoreTestApi")
  ] = { configureTaskFlowRegistryRuntime };
}
