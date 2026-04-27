import { closeTaskRegistrySqliteStore, deleteTaskAndDeliveryStateFromSqlite, deleteTaskDeliveryStateFromSqlite, deleteTaskRegistryRecordFromSqlite, loadTaskRegistryStateFromSqlite, saveTaskRegistryStateToSqlite, upsertTaskWithDeliveryStateToSqlite, upsertTaskDeliveryStateToSqlite, upsertTaskRegistryRecordToSqlite, } from "./task-registry.store.sqlite.js";
const defaultTaskRegistryStore = {
    loadSnapshot: loadTaskRegistryStateFromSqlite,
    saveSnapshot: saveTaskRegistryStateToSqlite,
    upsertTaskWithDeliveryState: upsertTaskWithDeliveryStateToSqlite,
    upsertTask: upsertTaskRegistryRecordToSqlite,
    deleteTaskWithDeliveryState: deleteTaskAndDeliveryStateFromSqlite,
    deleteTask: deleteTaskRegistryRecordFromSqlite,
    upsertDeliveryState: upsertTaskDeliveryStateToSqlite,
    deleteDeliveryState: deleteTaskDeliveryStateFromSqlite,
    close: closeTaskRegistrySqliteStore,
};
let configuredTaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryObservers = null;
export function getTaskRegistryStore() {
    return configuredTaskRegistryStore;
}
export function getTaskRegistryObservers() {
    return configuredTaskRegistryObservers;
}
export function configureTaskRegistryRuntime(params) {
    if (params.store) {
        configuredTaskRegistryStore = params.store;
    }
    if ("observers" in params) {
        configuredTaskRegistryObservers = params.observers ?? null;
    }
}
export function resetTaskRegistryRuntimeForTests() {
    configuredTaskRegistryStore.close?.();
    configuredTaskRegistryStore = defaultTaskRegistryStore;
    configuredTaskRegistryObservers = null;
}
