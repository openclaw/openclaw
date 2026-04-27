import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
export type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
export type TaskFlowRegistryStore = {
    loadSnapshot: () => TaskFlowRegistryStoreSnapshot;
    saveSnapshot: (snapshot: TaskFlowRegistryStoreSnapshot) => void;
    upsertFlow?: (flow: TaskFlowRecord) => void;
    deleteFlow?: (flowId: string) => void;
    close?: () => void;
};
export type TaskFlowRegistryObserverEvent = {
    kind: "restored";
    flows: TaskFlowRecord[];
} | {
    kind: "upserted";
    flow: TaskFlowRecord;
    previous?: TaskFlowRecord;
} | {
    kind: "deleted";
    flowId: string;
    previous: TaskFlowRecord;
};
export type TaskFlowRegistryObservers = {
    onEvent?: (event: TaskFlowRegistryObserverEvent) => void;
};
export declare function getTaskFlowRegistryStore(): TaskFlowRegistryStore;
export declare function getTaskFlowRegistryObservers(): TaskFlowRegistryObservers | null;
export declare function configureTaskFlowRegistryRuntime(params: {
    store?: TaskFlowRegistryStore;
    observers?: TaskFlowRegistryObservers | null;
}): void;
export declare function resetTaskFlowRegistryRuntimeForTests(): void;
