import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  clearTaskProgressBatches,
  getTaskRegistryProcessState,
  type TaskRegistryEventMutations,
} from "./task-registry.process-state.js";

const taskRegistryProcessState = getTaskRegistryProcessState();
let listenerStarter: () => void = () => {};
export function withPendingTaskRegistryEvents<T>(refresh: () => void, operation: () => T): T {
  const lease = taskRegistryProcessState.listener?.events.prepare();
  try {
    refresh();
    lease?.consume();
    return operation();
  } finally {
    lease?.release();
  }
}

export function hasPendingTaskRegistryEvents(): boolean {
  return taskRegistryProcessState.listener?.events.pending() ?? false;
}

export function captureTaskRegistryReadFence(
  admission: OpenClawStateDatabaseReadAdmission,
): Promise<void> {
  return taskRegistryProcessState.listener?.events.captureReadFence(admission) ?? Promise.resolve();
}

export function startTaskRegistryListener(): void {
  listenerStarter();
}

export function setTaskRegistryListenerStarter(starter: () => void): void {
  listenerStarter = starter;
}

export function claimTaskRegistryListenerStart(events: TaskRegistryEventMutations): boolean {
  if (taskRegistryProcessState.listener !== undefined) {
    return false;
  }
  taskRegistryProcessState.listener = { stop: null, events };
  return true;
}

export function setTaskRegistryListenerStop(stop: (() => void) | null): void {
  if (taskRegistryProcessState.listener) {
    taskRegistryProcessState.listener.stop = stop;
  }
}

export function resetTaskRegistryListenerState(): void {
  taskRegistryProcessState.listener?.stop?.();
  taskRegistryProcessState.listener = undefined;
  clearTaskProgressBatches();
}
