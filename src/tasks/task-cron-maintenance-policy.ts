import { isDeepStrictEqual } from "node:util";
import { resolveCronRunRecordTimestamp } from "../cron/run-history-detail.js";
import { prepareTaskRecordUpdate } from "./task-registry-transition.operation.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.operation.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

export type CronTerminalRecovery = {
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt: number;
  error?: string;
  terminalSummary?: string;
  detail?: TaskRecord["detail"];
};

export function canRecoverCronTask(task: TaskRecord): boolean {
  return (
    task.runtime === "cron" &&
    (task.status === "queued" ||
      task.status === "running" ||
      (task.status === "lost" &&
        Boolean(task.error?.trim().toLowerCase().includes("backing session missing"))))
  );
}

export function selectCronRecoveryRow(task: TaskRecord, rows: readonly TaskRecord[]) {
  return rows.find(
    (candidate) =>
      candidate.taskId === task.taskId ||
      (Boolean(task.runId?.trim()) && candidate.runId === task.runId),
  );
}

export function resolveCronTerminalRecovery(
  task: TaskRecord,
  row: TaskRecord | undefined,
): CronTerminalRecovery | undefined {
  if (
    !canRecoverCronTask(task) ||
    !row ||
    (row.status !== "succeeded" &&
      row.status !== "failed" &&
      row.status !== "timed_out" &&
      row.status !== "cancelled")
  ) {
    return undefined;
  }
  const endedAt = resolveCronRunRecordTimestamp(row);
  return {
    status: row.status,
    endedAt,
    lastEventAt: row.lastEventAt ?? endedAt,
    error: row.error,
    ...(row.terminalSummary !== undefined ? { terminalSummary: row.terminalSummary } : {}),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
  };
}

type CronTaskSelection = Pick<
  TaskRecord,
  | "taskId"
  | "createdAt"
  | "sourceId"
  | "runId"
  | "ownerKey"
  | "scopeKind"
  | "taskKind"
  | "childSessionKey"
  | "parentFlowId"
  | "status"
  | "startedAt"
  | "endedAt"
  | "lastEventAt"
  | "error"
  | "detail"
>;

export type CronTaskMaintenanceInput = {
  taskId: string;
  selected: CronTaskSelection;
  now: number;
  markLost: boolean;
};

export function captureCronTaskMaintenanceSelection(task: TaskRecord): CronTaskSelection {
  const {
    taskId,
    createdAt,
    sourceId,
    runId,
    ownerKey,
    scopeKind,
    taskKind,
    childSessionKey,
    parentFlowId,
    status,
    startedAt,
    endedAt,
    lastEventAt,
    error,
    detail,
  } = task;
  return {
    taskId,
    createdAt,
    sourceId,
    runId,
    ownerKey,
    scopeKind,
    taskKind,
    childSessionKey,
    parentFlowId,
    status,
    startedAt,
    endedAt,
    lastEventAt,
    error,
    detail,
  };
}

export function matchesCronTaskMaintenanceSelection(
  task: TaskRecord,
  selected: CronTaskSelection,
): boolean {
  return (
    task.runtime === "cron" &&
    task.taskId === selected.taskId &&
    task.createdAt === selected.createdAt &&
    task.sourceId === selected.sourceId &&
    task.runId === selected.runId &&
    task.ownerKey === selected.ownerKey &&
    task.scopeKind === selected.scopeKind &&
    task.taskKind === selected.taskKind &&
    task.childSessionKey === selected.childSessionKey &&
    task.parentFlowId === selected.parentFlowId
  );
}

export function prepareCronTaskMaintenance(
  current: TaskRecord | undefined,
  rows: readonly TaskRecord[],
  input: CronTaskMaintenanceInput,
): TaskRecordTransitionReceipt | null {
  if (!current || !matchesCronTaskMaintenanceSelection(current, input.selected)) {
    return null;
  }
  if (!canRecoverCronTask(current)) {
    // A peer may already have committed the selected run's terminal row. Publish
    // those canonical bytes and settle its effects without rewriting stale metadata.
    const previous = { ...current, ...input.selected };
    const recovery = resolveCronTerminalRecovery(previous, selectCronRecoveryRow(previous, rows));
    return recovery &&
      (current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "timed_out" ||
        current.status === "cancelled")
      ? {
          ...prepareTaskRecordUpdate(current, {}, input.now),
          previous,
          becomesTerminal: previous.status === "queued" || previous.status === "running",
          deliver: true,
        }
      : null;
  }
  const recovery = resolveCronTerminalRecovery(current, selectCronRecoveryRow(current, rows));
  let patch: Partial<TaskRecord>;
  if (recovery) {
    patch = recovery;
  } else {
    const selected = input.selected;
    if (
      !input.markLost ||
      (current.status !== "queued" && current.status !== "running") ||
      current.status !== selected.status ||
      current.startedAt !== selected.startedAt ||
      current.endedAt !== selected.endedAt ||
      current.lastEventAt !== selected.lastEventAt ||
      current.error !== selected.error ||
      !isDeepStrictEqual(current.detail, selected.detail)
    ) {
      return null;
    }
    const endedAt = current.endedAt ?? input.now;
    patch = {
      status: "lost",
      endedAt,
      lastEventAt: input.now,
      error: current.error ?? "backing session missing",
      cleanupAfter: resolveEffectiveTaskCleanupAfter({ ...current, status: "lost", endedAt }),
    };
  }
  return { ...prepareTaskRecordUpdate(current, patch, input.now), deliver: true };
}
