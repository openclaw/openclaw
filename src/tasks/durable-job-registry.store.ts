import {
  appendDurableJobTransitionToSqlite,
  closeDurableJobRegistrySqliteStore,
  deleteDurableJobRegistryRecordFromSqlite,
  loadDurableJobRegistryStateFromSqlite,
  saveDurableJobRegistryStateToSqlite,
  upsertDurableJobRegistryRecordToSqlite,
} from "./durable-job-registry.store.sqlite.js";
import type { DurableJobRegistryStoreSnapshot } from "./durable-job-registry.store.types.js";
import type {
  DurableJobRecord,
  DurableJobTransitionRecord,
} from "./durable-job-registry.types.js";

export type { DurableJobRegistryStoreSnapshot } from "./durable-job-registry.store.types.js";

export type DurableJobRegistryStore = {
  loadSnapshot: () => DurableJobRegistryStoreSnapshot;
  saveSnapshot: (snapshot: DurableJobRegistryStoreSnapshot) => void;
  upsertJob?: (job: DurableJobRecord) => void;
  deleteJob?: (jobId: string) => void;
  appendTransition?: (transition: DurableJobTransitionRecord) => void;
  close?: () => void;
};

export type DurableJobRegistryObserverEvent =
  | {
      kind: "restored";
      jobs: DurableJobRecord[];
      transitionsByJobId: Map<string, DurableJobTransitionRecord[]>;
    }
  | {
      kind: "upserted";
      job: DurableJobRecord;
      previous?: DurableJobRecord;
    }
  | {
      kind: "deleted";
      jobId: string;
      previous: DurableJobRecord;
    }
  | {
      kind: "transition_appended";
      transition: DurableJobTransitionRecord;
    };

export type DurableJobRegistryObservers = {
  onEvent?: (event: DurableJobRegistryObserverEvent) => void;
};

const defaultDurableJobRegistryStore: DurableJobRegistryStore = {
  loadSnapshot: loadDurableJobRegistryStateFromSqlite,
  saveSnapshot: saveDurableJobRegistryStateToSqlite,
  upsertJob: upsertDurableJobRegistryRecordToSqlite,
  deleteJob: deleteDurableJobRegistryRecordFromSqlite,
  appendTransition: appendDurableJobTransitionToSqlite,
  close: closeDurableJobRegistrySqliteStore,
};

let configuredDurableJobRegistryStore: DurableJobRegistryStore = defaultDurableJobRegistryStore;
let configuredDurableJobRegistryObservers: DurableJobRegistryObservers | null = null;

export function getDurableJobRegistryStore(): DurableJobRegistryStore {
  return configuredDurableJobRegistryStore;
}

export function getDurableJobRegistryObservers(): DurableJobRegistryObservers | null {
  return configuredDurableJobRegistryObservers;
}

export function configureDurableJobRegistryRuntime(params: {
  store?: DurableJobRegistryStore;
  observers?: DurableJobRegistryObservers | null;
}) {
  if (params.store) {
    configuredDurableJobRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredDurableJobRegistryObservers = params.observers ?? null;
  }
}

export function resetDurableJobRegistryRuntimeForTests() {
  configuredDurableJobRegistryStore.close?.();
  configuredDurableJobRegistryStore = defaultDurableJobRegistryStore;
  configuredDurableJobRegistryObservers = null;
}
