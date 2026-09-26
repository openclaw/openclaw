import { shouldPruneTerminalTask } from "./cron-history-retention.js";
import { prepareTaskRecordUpdate } from "./task-registry-transition.operation.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveTaskCleanupAfter, shouldStampCleanupAfter } from "./task-retention.js";

type TaskRetentionSelection = Pick<
  TaskRecord,
  | "taskId"
  | "createdAt"
  | "runtime"
  | "runId"
  | "scopeKind"
  | "ownerKey"
  | "childSessionKey"
  | "parentFlowId"
>;

type TaskRetentionDecisionInput = {
  taskId: string;
  selection: TaskRetentionSelection;
  now: number;
  cronHistoryOverflow: boolean;
};

export type TaskRetentionInput = TaskRetentionDecisionInput & { sourceVersion: string };

export type TaskRetentionResult =
  | { kind: "unchanged" }
  | { kind: "pruned"; previous: TaskRecord }
  | { kind: "stamped"; previous: TaskRecord; task: TaskRecord };

/** Retention also covers ledger rows without a live run identity. */
export function captureTaskRetentionSelection(task: TaskRecord): TaskRetentionSelection {
  return {
    taskId: task.taskId,
    createdAt: task.createdAt,
    runtime: task.runtime,
    runId: task.runId,
    scopeKind: task.scopeKind,
    ownerKey: task.ownerKey,
    childSessionKey: task.childSessionKey,
    parentFlowId: task.parentFlowId,
  };
}

export function prepareTaskRetention(
  current: TaskRecord | undefined,
  input: TaskRetentionDecisionInput,
): TaskRetentionResult {
  if (
    !current ||
    current.taskId !== input.taskId ||
    current.taskId !== input.selection.taskId ||
    current.createdAt !== input.selection.createdAt ||
    current.runtime !== input.selection.runtime ||
    current.runId !== input.selection.runId ||
    current.scopeKind !== input.selection.scopeKind ||
    current.ownerKey !== input.selection.ownerKey ||
    current.childSessionKey !== input.selection.childSessionKey ||
    current.parentFlowId !== input.selection.parentFlowId
  ) {
    return { kind: "unchanged" };
  }
  const overflow = new Set(input.cronHistoryOverflow ? [input.taskId] : []);
  if (shouldPruneTerminalTask(current, input.now, overflow)) {
    return { kind: "pruned", previous: current };
  }
  if (shouldStampCleanupAfter(current)) {
    const { task, persisted } = prepareTaskRecordUpdate(
      current,
      { cleanupAfter: resolveTaskCleanupAfter(current) },
      input.now,
    );
    if (persisted) {
      return { kind: "stamped", previous: current, task };
    }
  }
  return { kind: "unchanged" };
}
