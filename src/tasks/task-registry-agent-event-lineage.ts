import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import type { PendingTaskAgentEvent } from "./task-registry-agent-events.types.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type { TaskPersistenceReceipt } from "./task-registry.types.js";

type ReceiptListener = {
  databaseKey: string;
  store: TaskRegistryStore;
  onCommitted: (previous: TaskPersistenceReceipt, next: TaskPersistenceReceipt) => void;
};

const listenersByRun = new Map<string, Set<ReceiptListener>>();

/** Live creation receipts retain facts only until their original owner settles. */
export function retainTaskAgentEventLineage(
  admission: OpenClawStateDatabaseReadAdmission,
  runId: string,
  onCommitted: ReceiptListener["onCommitted"],
): () => void {
  admission.assertCurrent();
  const listener = {
    databaseKey: admission.identity.key,
    store: getTaskRegistryStore(),
    onCommitted,
  };
  const listeners = listenersByRun.get(runId) ?? new Set<ReceiptListener>();
  listeners.add(listener);
  listenersByRun.set(runId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && listenersByRun.get(runId) === listeners) {
      listenersByRun.delete(runId);
    }
  };
}

export function publishTaskAgentEventLineage(pending: PendingTaskAgentEvent): void {
  // Prepared native targets may still roll back. Only acknowledged commits
  // advance live receipts, even when publication or result delivery later fails.
  if (
    pending.lineagePublished ||
    (!pending.receipt && pending.commitFacts === undefined) ||
    !pending.committedTarget
  ) {
    return;
  }
  pending.lineagePublished = true;
  const previous = pending.input.expectedTask;
  const next = pending.committedTarget;
  for (const listener of listenersByRun.get(previous.runId) ?? []) {
    if (
      listener.databaseKey === pending.context.admission.identity.key &&
      listener.store === pending.store
    ) {
      listener.onCommitted(previous, next);
    }
  }
}

export function clearTaskAgentEventLineage(databaseKey?: string): void {
  for (const [runId, listeners] of listenersByRun) {
    for (const listener of listeners) {
      if (databaseKey === undefined || listener.databaseKey === databaseKey) {
        listeners.delete(listener);
      }
    }
    if (!listeners.size) {
      listenersByRun.delete(runId);
    }
  }
}
