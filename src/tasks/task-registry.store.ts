import {
  closeTaskRegistrySqliteStore,
  deleteTaskRegistryRecordFromSqlite,
  loadTaskRegistrySnapshotFromSqlite,
  saveTaskRegistrySnapshotToSqlite,
  upsertTaskRegistryRecordToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRegistryStore = {
  loadSnapshot: () => Map<string, TaskRecord>;
  saveSnapshot: (tasks: ReadonlyMap<string, TaskRecord>) => void;
  upsertTask?: (task: TaskRecord) => void;
  deleteTask?: (taskId: string) => void;
  close?: () => void;
};

export type TaskRegistryHookEvent =
  | {
      kind: "restored";
      tasks: TaskRecord[];
    }
  | {
      kind: "upserted";
      task: TaskRecord;
      previous?: TaskRecord;
    }
  | {
      kind: "deleted";
      taskId: string;
      previous: TaskRecord;
    };

export type TaskRegistryHooks = {
  // Hooks are incremental/observational. Snapshot persistence belongs to TaskRegistryStore.
  onEvent?: (event: TaskRegistryHookEvent) => void;
};

const defaultTaskRegistryStore: TaskRegistryStore = {
  loadSnapshot: loadTaskRegistrySnapshotFromSqlite,
  saveSnapshot: saveTaskRegistrySnapshotToSqlite,
  upsertTask: upsertTaskRegistryRecordToSqlite,
  deleteTask: deleteTaskRegistryRecordFromSqlite,
  close: closeTaskRegistrySqliteStore,
};

let configuredTaskRegistryStore: TaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryHooks: TaskRegistryHooks | null = null;

export function getTaskRegistryStore(): TaskRegistryStore {
  return configuredTaskRegistryStore;
}

export function getTaskRegistryHooks(): TaskRegistryHooks | null {
  return configuredTaskRegistryHooks;
}

export function configureTaskRegistryRuntime(params: {
  store?: TaskRegistryStore;
  hooks?: TaskRegistryHooks | null;
}) {
  if (params.store) {
    configuredTaskRegistryStore = params.store;
  }
  if ("hooks" in params) {
    configuredTaskRegistryHooks = params.hooks ?? null;
  }
}

export function resetTaskRegistryRuntimeForTests() {
  configuredTaskRegistryStore.close?.();
  configuredTaskRegistryStore = defaultTaskRegistryStore;
  configuredTaskRegistryHooks = null;
}
