import { isTerminalTaskStatus } from "./task-executor-policy.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import {
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import {
  addOwnerKeyIndex,
  addParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  bumpTaskRegistryRevision,
  deleteOwnerKeyIndex,
  deleteParentFlowIdIndex,
  deleteRelatedSessionKeyIndex,
  emitTaskRegistryObserverEvent,
  rebuildRunIdIndex,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Publishes a record already committed by a cross-owner shared-state transaction. */
export function publishTaskRecordAfterAtomicStore(
  record: TaskRecord,
  options?: { deferredObserverEvents?: Array<() => void> },
): TaskRecord {
  const next = normalizeTaskTimestamps(cloneTaskRecord(record));
  const current = tasks.get(next.taskId);
  const becomesTerminal =
    current !== undefined &&
    !isTerminalTaskStatus(current.status) &&
    isTerminalTaskStatus(next.status);
  if (becomesTerminal) {
    flushTaskActivity(next.taskId);
  }
  if (current) {
    deleteOwnerKeyIndex(next.taskId, current);
    deleteParentFlowIdIndex(next.taskId, current);
    deleteRelatedSessionKeyIndex(next.taskId, current);
  }
  tasks.set(next.taskId, next);
  bumpTaskRegistryRevision();
  if (becomesTerminal) {
    clearTaskActivity(next.taskId);
  }
  addOwnerKeyIndex(next.taskId, next);
  addParentFlowIdIndex(next.taskId, next);
  addRelatedSessionKeyIndex(next.taskId, next);
  rebuildRunIdIndex();
  const emit = () =>
    emitTaskRegistryObserverEvent(() => ({
      kind: "upserted",
      task: cloneTaskRecordForObserver(next),
      ...(current ? { previous: cloneTaskRecordForObserver(current) } : {}),
    }));
  if (options?.deferredObserverEvents) {
    options.deferredObserverEvents.push(emit);
  } else {
    emit();
  }
  return cloneTaskRecord(next);
}
