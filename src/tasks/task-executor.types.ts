import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskMutationContext = {
  context: OpenClawStateWorkerContext;
  store: TaskRegistryStore;
  flowStore: ReturnType<typeof getTaskFlowRegistryStore>;
  assertStores: () => void;
};

export type CoreTaskCreation = TaskMutationContext & { task: TaskRecord };
