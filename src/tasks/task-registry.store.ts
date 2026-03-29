import {
  loadTaskRegistrySnapshotFromJson,
  saveTaskRegistrySnapshotToJson,
} from "./task-registry.store.json.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRegistryStore = {
  loadSnapshot: () => Map<string, TaskRecord>;
  saveSnapshot: (tasks: ReadonlyMap<string, TaskRecord>) => void;
};

export type TaskRegistryHookEvent =
  | {
      kind: "restored";
      tasks: TaskRecord[];
    }
  | {
      kind: "persisted";
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
  onEvent?: (event: TaskRegistryHookEvent) => void;
};

const defaultTaskRegistryStore: TaskRegistryStore = {
  loadSnapshot: loadTaskRegistrySnapshotFromJson,
  saveSnapshot: saveTaskRegistrySnapshotToJson,
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
  configuredTaskRegistryStore = defaultTaskRegistryStore;
  configuredTaskRegistryHooks = null;
}
