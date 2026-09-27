// Summarizes task registry records for CLI and API surfaces.
import {
  addTaskAuditRecordSummary,
  type RetainedLostTaskAuditSummary,
  type TaskAuditRecord,
  type TaskAuditSummary,
} from "./task-registry.audit.js";
import { createEmptyTaskAuditSummary } from "./task-registry.audit.shared.js";
import type {
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntimeCounts,
  TaskRuntime,
  TaskStatus,
  TaskStatusCounts,
} from "./task-registry.types.js";

export type TaskStatusSummary = {
  tasks: TaskRegistrySummary;
  taskAudit: TaskAuditSummary;
  taskAuditRetainedLost: RetainedLostTaskAuditSummary;
};

// Summary helpers keep task status/runtime counters stable for UI and plugin views.
function createEmptyTaskStatusCounts(): TaskStatusCounts {
  return {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    timed_out: 0,
    cancelled: 0,
    lost: 0,
  };
}

function createEmptyTaskRuntimeCounts(): TaskRuntimeCounts {
  return {
    subagent: 0,
    acp: 0,
    cli: 0,
    cron: 0,
  };
}

export function createEmptyTaskRegistrySummary(): TaskRegistrySummary {
  return {
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: createEmptyTaskStatusCounts(),
    byRuntime: createEmptyTaskRuntimeCounts(),
  };
}

export function addTaskRegistrySummaryCounts(
  summary: TaskRegistrySummary,
  runtime: TaskRuntime,
  status: TaskStatus,
  count: number,
): void {
  summary.total += count;
  summary.byStatus[status] += count;
  summary.byRuntime[runtime] += count;
  if (status === "queued" || status === "running") {
    summary.active += count;
  } else {
    summary.terminal += count;
  }
  if (status === "failed" || status === "timed_out" || status === "lost") {
    summary.failures += count;
  }
}

export function summarizeTaskRecords(records: Iterable<TaskRecord>): TaskRegistrySummary {
  const summary = createEmptyTaskRegistrySummary();
  for (const task of records) {
    addTaskRegistrySummaryCounts(summary, task.runtime, task.status, 1);
  }
  return summary;
}

export function createEmptyTaskStatusSummary(): TaskStatusSummary {
  return {
    tasks: createEmptyTaskRegistrySummary(),
    taskAudit: createEmptyTaskAuditSummary(),
    taskAuditRetainedLost: { count: 0 },
  };
}

export function addTaskStatusSummaryRecord(
  summary: TaskStatusSummary,
  task: TaskAuditRecord & Pick<TaskRecord, "runtime">,
  now: number,
): void {
  addTaskRegistrySummaryCounts(summary.tasks, task.runtime, task.status, 1);
  if (addTaskAuditRecordSummary(summary.taskAudit, summary.taskAuditRetainedLost, task, now)) {
    summary.tasks.failures -= 1;
  }
}
