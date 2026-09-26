import { readTaskBackingInstance, sameTaskBackingInstance } from "./task-backing-records.js";
import { normalizeTaskTimestamps, sameTaskRunScope } from "./task-registry-records.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Runtime events can correct a run's earliest timestamp without replacing its assignment. */
export function matchesTaskCancellationCreatedAt(
  current: TaskRecord,
  selected: Pick<TaskRecord, "createdAt" | "runId">,
): boolean {
  return (
    current.createdAt === selected.createdAt ||
    (Boolean(selected.runId?.trim()) &&
      normalizeTaskTimestamps({ ...current, createdAt: selected.createdAt }).createdAt ===
        current.createdAt)
  );
}

/** The visible assignment fields also identify canonical publication predecessors. */
export function matchesTaskCancellationScope(current: TaskRecord, selected: TaskRecord): boolean {
  return (
    current.taskId === selected.taskId &&
    current.taskKind === selected.taskKind &&
    current.requesterAgentId === selected.requesterAgentId &&
    current.sourceId === selected.sourceId &&
    current.parentFlowId === selected.parentFlowId &&
    sameTaskRunScope(current, selected)
  );
}

/** Cancellation binds an assignment, including legacy rows without a run identity. */
export function matchesTaskCancellationSelection(
  current: TaskRecord,
  selected: TaskRecord,
): boolean {
  const backing = readTaskBackingInstance(selected.detail);
  const currentBacking = readTaskBackingInstance(current.detail);
  return (
    matchesTaskCancellationScope(current, selected) &&
    matchesTaskCancellationCreatedAt(current, selected) &&
    (backing
      ? Boolean(currentBacking && sameTaskBackingInstance(backing, currentBacking))
      : currentBacking === undefined)
  );
}
