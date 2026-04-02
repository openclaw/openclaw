import {
  closeFlowRegistrySqliteStore,
  deleteFlowRegistryRecordFromSqlite,
  loadFlowRegistryStateFromSqlite,
  saveFlowRegistryStateToSqlite,
  upsertFlowRegistryRecordToSqlite,
} from "./flow-registry.store.sqlite.js";
import type { FlowRecord } from "./flow-registry.types.js";

export type FlowRegistryStoreSnapshot = {
  flows: Map<string, FlowRecord>;
};

export type FlowRegistryStore = {
  loadSnapshot: () => FlowRegistryStoreSnapshot;
  saveSnapshot: (snapshot: FlowRegistryStoreSnapshot) => void;
  upsertFlow?: (flow: FlowRecord) => void;
  deleteFlow?: (flowId: string) => void;
  close?: () => void;
};

export type FlowRegistryHookEvent =
  | {
      kind: "restored";
      flows: FlowRecord[];
    }
  | {
      kind: "upserted";
      flow: FlowRecord;
      previous?: FlowRecord;
    }
  | {
      kind: "deleted";
      flowId: string;
      previous: FlowRecord;
    };

export type FlowRegistryHooks = {
  // Hooks are incremental/observational. Snapshot persistence belongs to FlowRegistryStore.
  onEvent?: (event: FlowRegistryHookEvent) => void;
};

const defaultFlowRegistryStore: FlowRegistryStore = {
  loadSnapshot: loadFlowRegistryStateFromSqlite,
  saveSnapshot: saveFlowRegistryStateToSqlite,
  upsertFlow: upsertFlowRegistryRecordToSqlite,
  deleteFlow: deleteFlowRegistryRecordFromSqlite,
  close: closeFlowRegistrySqliteStore,
};

let configuredFlowRegistryStore: FlowRegistryStore = defaultFlowRegistryStore;
let configuredFlowRegistryHooks: FlowRegistryHooks | null = null;

export function getFlowRegistryStore(): FlowRegistryStore {
  return configuredFlowRegistryStore;
}

export function getFlowRegistryHooks(): FlowRegistryHooks | null {
  return configuredFlowRegistryHooks;
}

export function configureFlowRegistryRuntime(params: {
  store?: FlowRegistryStore;
  hooks?: FlowRegistryHooks | null;
}) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
  if ("hooks" in params) {
    configuredFlowRegistryHooks = params.hooks ?? null;
  }
}

export function resetFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
  configuredFlowRegistryHooks = null;
}
