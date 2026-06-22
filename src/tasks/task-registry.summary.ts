// Summarizes task registry records for CLI and API surfaces.
import type {
  TaskDeliveryStatus,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntimeCounts,
  TaskStatusCounts,
} from "./task-registry.types.js";

export type TaskDeliveryStatusCounts = Record<TaskDeliveryStatus, number>;

export type TaskRegistryPressureSummary = TaskRegistrySummary & {
  byDeliveryStatus: TaskDeliveryStatusCounts;
  activeDelivery: TaskDeliveryStatusCounts;
  terminalDelivery: TaskDeliveryStatusCounts;
  activeSessionQueued: number;
  terminalSessionQueued: number;
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

function createEmptyTaskDeliveryStatusCounts(): TaskDeliveryStatusCounts {
  return {
    pending: 0,
    delivered: 0,
    session_queued: 0,
    failed: 0,
    parent_missing: 0,
    not_applicable: 0,
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

export function summarizeTaskRecords(records: Iterable<TaskRecord>): TaskRegistrySummary {
  const summary = createEmptyTaskRegistrySummary();
  for (const task of records) {
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
  return summary;
}

export function summarizeTaskPressure(records: Iterable<TaskRecord>): TaskRegistryPressureSummary {
  const tasks = [...records];
  const summary: TaskRegistryPressureSummary = {
    ...summarizeTaskRecords(tasks),
    byDeliveryStatus: createEmptyTaskDeliveryStatusCounts(),
    activeDelivery: createEmptyTaskDeliveryStatusCounts(),
    terminalDelivery: createEmptyTaskDeliveryStatusCounts(),
    activeSessionQueued: 0,
    terminalSessionQueued: 0,
  };
  for (const task of tasks) {
    summary.byDeliveryStatus[task.deliveryStatus] += 1;
    if (task.status === "queued" || task.status === "running") {
      summary.activeDelivery[task.deliveryStatus] += 1;
      if (task.deliveryStatus === "session_queued") {
        summary.activeSessionQueued += 1;
      }
    } else {
      summary.terminalDelivery[task.deliveryStatus] += 1;
      if (task.deliveryStatus === "session_queued") {
        summary.terminalSessionQueued += 1;
      }
    }
  }
  return summary;
}
