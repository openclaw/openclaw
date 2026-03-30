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

const defaultFlowRegistryStore: FlowRegistryStore = {
	loadSnapshot: loadFlowRegistryStateFromSqlite,
	saveSnapshot: saveFlowRegistryStateToSqlite,
	upsertFlow: upsertFlowRegistryRecordToSqlite,
	deleteFlow: deleteFlowRegistryRecordFromSqlite,
	close: closeFlowRegistrySqliteStore,
};

let configuredFlowRegistryStore: FlowRegistryStore = defaultFlowRegistryStore;

export function getFlowRegistryStore(): FlowRegistryStore {
	return configuredFlowRegistryStore;
}

export function configureFlowRegistryRuntime(params: {
	store?: FlowRegistryStore;
}) {
	if (params.store) {
		configuredFlowRegistryStore = params.store;
	}
}

export function resetFlowRegistryRuntimeForTests() {
	configuredFlowRegistryStore.close?.();
	configuredFlowRegistryStore = defaultFlowRegistryStore;
}
