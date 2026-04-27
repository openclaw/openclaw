import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
export declare function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot;
export declare function saveTaskRegistryStateToSqlite(snapshot: TaskRegistryStoreSnapshot): void;
export declare function upsertTaskRegistryRecordToSqlite(task: TaskRecord): void;
export declare function upsertTaskWithDeliveryStateToSqlite(params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
}): void;
export declare function deleteTaskRegistryRecordFromSqlite(taskId: string): void;
export declare function deleteTaskAndDeliveryStateFromSqlite(taskId: string): void;
export declare function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState): void;
export declare function deleteTaskDeliveryStateFromSqlite(taskId: string): void;
export declare function closeTaskRegistrySqliteStore(): void;
