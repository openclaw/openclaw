// Stores managed task-flow records and delivers registry observer snapshots.
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  cloneFlowRecord,
  areTaskFlowRecordsEqual,
  normalizeRestoredFlowRecord,
  snapshotFlowRecords,
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
  loadSnapshot: () => TaskFlowRegistryStoreSnapshot;
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

export type TaskFlowRegistryObserverEvent =
  | {
      kind: "restored";
      flows: TaskFlowRecord[];
    }
  | {
      kind: "upserted";
      flow: TaskFlowRecord;
      previous?: TaskFlowRecord;
    }
  | {
      kind: "deleted";
      flowId: string;
      previous: TaskFlowRecord;
    };

export type FlowRegistryPublication =
  | Exclude<TaskFlowRegistryObserverEvent, { kind: "restored" }>
  | { kind: "restored"; flows: ReadonlyMap<string, TaskFlowRecord> };

type TaskFlowRegistryObservers = {
  // Observers are incremental/best-effort only. Persistence belongs to TaskFlowRegistryStore.
  onEvent?: (event: TaskFlowRegistryObserverEvent) => void;
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
let configuredFlowRegistryObservers: TaskFlowRegistryObservers | null = null;

export function getTaskFlowRegistryStore(): TaskFlowRegistryStore {
  return configuredFlowRegistryStore;
}

export function getTaskFlowRegistryObservers(): TaskFlowRegistryObservers | null {
  return configuredFlowRegistryObservers;
}

function configureTaskFlowRegistryRuntime(params: {
  store?: TaskFlowRegistryStore;
  observers?: TaskFlowRegistryObservers | null;
}) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredFlowRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
  configuredFlowRegistryObservers = null;
}

export function deliverTaskFlowRegistryObserverEvent(
  observers: TaskFlowRegistryObservers | null,
  event: FlowRegistryPublication,
): void {
  if (!observers?.onEvent) {
    return;
  }
  if (event.kind === "restored") {
    observers.onEvent({ kind: "restored", flows: snapshotFlowRecords(event.flows) });
  } else if (event.kind === "upserted") {
    observers.onEvent({
      kind: "upserted",
      flow: cloneFlowRecord(event.flow),
      ...(event.previous ? { previous: cloneFlowRecord(event.previous) } : {}),
    });
  } else {
    observers.onEvent({ ...event, previous: cloneFlowRecord(event.previous) });
  }
}

export function prepareTaskFlowRecordPublication(params: {
  flowId: string;
  cached: TaskFlowRecord | undefined;
  current: TaskFlowRecord | undefined;
  previous: TaskFlowRecord | undefined;
  applied: boolean;
  read: () => TaskFlowRecord | undefined;
  write: (flow: TaskFlowRecord | undefined) => void;
  advance: () => void;
  onCommitted: () => void;
  emit: (createEvent: () => FlowRegistryPublication) => void;
}): TaskFlowRegistryUpdatePublication {
  const { flowId, cached, current, previous, applied, read, write, advance, onCommitted, emit } =
    params;
  const canonical = current ? cloneFlowRecord(current) : undefined;
  const changed =
    applied ||
    !areTaskFlowRecordsEqual(cached ? normalizeRestoredFlowRecord(cached) : undefined, canonical);
  const next = changed ? canonical : cached;
  let committed: TaskFlowRecord | undefined;
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
      // Capture the final staged entry before any observer can reenter this owner.
      committed = read();
    },
    publish: () => {
      if (!changed || read() !== committed) {
        return;
      }
      if (next) {
        emit(() => ({
          kind: "upserted",
          flow: next,
          ...(previous ? { previous } : {}),
        }));
      } else if (previous) {
        emit(() => ({
          kind: "deleted",
          flowId,
          previous,
        }));
      }
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
