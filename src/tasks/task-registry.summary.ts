import type {
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntimeCounts,
  TaskStatusCounts,
} from "./task-registry.types.js";
import { summarizeTaskFailureEvidence } from "./task-status.js";

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
    recentFailures: 0,
    historicalFailures: 0,
    byStatus: createEmptyTaskStatusCounts(),
    byRuntime: createEmptyTaskRuntimeCounts(),
  };
}

export function summarizeTaskRecords(records: Iterable<TaskRecord>): TaskRegistrySummary {
  const tasks = Array.from(records);
  const summary = createEmptyTaskRegistrySummary();
  for (const task of tasks) {
    summary.total += 1;
    summary.byStatus[task.status] += 1;
    summary.byRuntime[task.runtime] += 1;
    if (task.status === "queued" || task.status === "running") {
      summary.active += 1;
    } else {
      summary.terminal += 1;
    }
    if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
      summary.failures += 1;
    }
  }
  const failureEvidence = summarizeTaskFailureEvidence(tasks);
  summary.recentFailures = failureEvidence.recentFailures;
  summary.historicalFailures = failureEvidence.historicalFailures;
  return summary;
}
