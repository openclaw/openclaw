import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
export declare function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot;
export declare function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot): void;
export declare function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord): void;
export declare function deleteTaskFlowRegistryRecordFromSqlite(flowId: string): void;
export declare function closeTaskFlowRegistrySqliteStore(): void;
