import { flushTaskActivity } from "./task-registry-activity.js";
import {
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import {
  clearTaskActivity,
  bumpTaskRegistryRevision,
  emitTaskRegistryObserverEvent,
  tasks,
} from "./task-registry-state.js";
import {
  updateTaskIndexes,
  recordTaskRegistryProjectionWrite,
} from "./task-registry.process-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

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
  const indexedCurrent = tasks.get(next.taskId);
  tasks.set(next.taskId, next);
  recordTaskRegistryProjectionWrite("task", next.taskId);
  bumpTaskRegistryRevision();
  if (becomesTerminal) {
    clearTaskActivity(next.taskId);
  }
  // Atomic publication has historically made the committed row the equal-time winner.
  updateTaskIndexes(indexedCurrent, next, { reinsertUnchanged: true });
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
