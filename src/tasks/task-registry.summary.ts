import type {
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntimeCounts,
  TaskStatusCounts,
} from "./task-registry.types.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

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
  const taskList = [...records];
  const summary = createEmptyTaskRegistrySummary();
  const snapshot = buildTaskStatusSnapshot(taskList);

  summary.active = snapshot.activeCount;
  summary.terminal = Math.max(0, taskList.length - snapshot.activeCount);
  summary.recentFailures = snapshot.recentFailureCount;
  summary.historicalFailures = snapshot.historicalFailureCount;
  summary.failures = snapshot.recentFailureCount + snapshot.historicalFailureCount;

  for (const task of taskList) {
    summary.total += 1;
    summary.byStatus[task.status] += 1;
    summary.byRuntime[task.runtime] += 1;
  }
  return summary;
}
