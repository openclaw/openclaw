import {
  closeTaskFlowRegistrySqliteStore,
  deleteTaskFlowRegistryRecordFromSqlite,
  loadTaskFlowRegistryStateFromSqlite,
  saveTaskFlowRegistryStateToSqlite,
  upsertTaskFlowRegistryRecordToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};

export type TaskFlowRegistryStore = {
  loadSnapshot: () => TaskFlowRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskFlowRegistryStoreSnapshot) => void;
  upsertFlow?: (flow: TaskFlowRecord) => void;
  deleteFlow?: (flowId: string) => void;
  close?: () => void;
};

export type TaskFlowRegistryHookEvent =
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

export type TaskFlowRegistryHooks = {
  // Hooks are incremental/observational. Snapshot persistence belongs to TaskFlowRegistryStore.
  onEvent?: (event: TaskFlowRegistryHookEvent) => void;
};

const defaultFlowRegistryStore: TaskFlowRegistryStore = {
  loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
  saveSnapshot: saveTaskFlowRegistryStateToSqlite,
  upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
  deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
  close: closeTaskFlowRegistrySqliteStore,
};

let configuredFlowRegistryStore: TaskFlowRegistryStore = defaultFlowRegistryStore;
let configuredFlowRegistryHooks: TaskFlowRegistryHooks | null = null;

export function getTaskFlowRegistryStore(): TaskFlowRegistryStore {
  return configuredFlowRegistryStore;
}

export function getTaskFlowRegistryHooks(): TaskFlowRegistryHooks | null {
  return configuredFlowRegistryHooks;
}

export function configureTaskFlowRegistryRuntime(params: {
  store?: TaskFlowRegistryStore;
  hooks?: TaskFlowRegistryHooks | null;
}) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
  if ("hooks" in params) {
    configuredFlowRegistryHooks = params.hooks ?? null;
  }
}

export function resetTaskFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
  configuredFlowRegistryHooks = null;
}
