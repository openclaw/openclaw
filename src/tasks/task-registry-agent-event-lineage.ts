import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { sameTaskAgentEventSource } from "./task-registry-agent-event-source.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import type { PendingTaskAgentEvent } from "./task-registry-agent-events.types.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type { TaskPersistenceReceipt } from "./task-registry.types.js";

type ReceiptListener = {
  databaseKey: string;
  store: TaskRegistryStore;
  onCommitted: (previous: TaskPersistenceReceipt, next: TaskPersistenceReceipt) => void;
  eventOwner?: {
    source: PendingTaskAgentEvent["source"];
    backing: TaskAgentEventTarget["backing"];
  };
};

const listenersByRun = new Map<string, Set<ReceiptListener>>();

/** Live consumers retain committed timestamp lineage only while their original owner needs it. */
export function retainTaskAgentEventLineage(
  admission: OpenClawStateDatabaseReadAdmission,
  runId: string,
  onCommitted: ReceiptListener["onCommitted"],
  eventOwner?: ReceiptListener["eventOwner"],
): () => void {
  admission.assertCurrent();
  const listener = {
    databaseKey: admission.identity.key,
    store: getTaskRegistryStore(),
    onCommitted,
    eventOwner,
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
      listener.store === pending.store &&
      (!listener.eventOwner ||
        (sameTaskAgentEventSource(listener.eventOwner.source, pending.source) &&
          isDeepStrictEqual(listener.eventOwner.backing, pending.input.backing)))
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
