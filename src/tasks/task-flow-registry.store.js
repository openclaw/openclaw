import { closeTaskFlowRegistrySqliteStore, deleteTaskFlowRegistryRecordFromSqlite, loadTaskFlowRegistryStateFromSqlite, saveTaskFlowRegistryStateToSqlite, upsertTaskFlowRegistryRecordToSqlite, } from "./task-flow-registry.store.sqlite.js";
const defaultFlowRegistryStore = {
    loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
    saveSnapshot: saveTaskFlowRegistryStateToSqlite,
    upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
    deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
    close: closeTaskFlowRegistrySqliteStore,
};
let configuredFlowRegistryStore = defaultFlowRegistryStore;
let configuredFlowRegistryObservers = null;
export function getTaskFlowRegistryStore() {
    return configuredFlowRegistryStore;
}
export function getTaskFlowRegistryObservers() {
    return configuredFlowRegistryObservers;
}
export function configureTaskFlowRegistryRuntime(params) {
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
