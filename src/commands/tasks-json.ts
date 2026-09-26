// JSON-only task commands use read-only registry snapshots without maintenance reconciliation.
// This avoids broader task runtimes so short-lived CLI processes exit cleanly.

import { parseCliEnumFilter } from "../cli/enum-filter.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import { listTaskAuditFindings } from "../tasks/task-registry.audit.js";
import {
  matchesTaskStatusFilter,
  TASK_RUNTIMES,
  TASK_STATUS_FILTERS,
} from "../tasks/task-registry.types.js";
import {
  TASK_SYSTEM_AUDIT_CODES,
  TASK_SYSTEM_AUDIT_SEVERITIES,
  type TaskSystemAuditCode,
  type TaskSystemAuditSeverity,
} from "../tasks/task-system-audit.types.js";
import {
  buildTaskSystemAuditJsonPayload,
  buildTaskSystemAuditFindings,
} from "./tasks-audit-system.js";

type TasksListJsonArgs = {
  json?: boolean;
  runtime?: string;
  status?: string;
};

type TasksAuditJsonArgs = {
  json?: boolean;
  severity?: string;
  code?: string;
  limit?: number;
};

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const tasks = listTaskRecords();
  const taskFindings = listTaskAuditFindings({ tasks });
  const flowFindings = listTaskFlowAuditFindings();
  const result = buildTaskSystemAuditFindings({
    taskFindings,
    flowFindings,
    severityFilter: params.severityFilter,
    codeFilter: params.codeFilter,
  });
  return result;
}

function buildTasksListJsonPayload(opts: TasksListJsonArgs) {
  const runtimeFilter = parseCliEnumFilter(opts.runtime, "--runtime", TASK_RUNTIMES);
  const statusFilter = parseCliEnumFilter(opts.status, "--status", TASK_STATUS_FILTERS);
  const tasks = listTaskRecords((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && !matchesTaskStatusFilter(task, statusFilter)) {
      return false;
    }
    return true;
  });
  return {
    count: tasks.length,
    runtime: runtimeFilter ?? null,
    status: statusFilter ?? null,
    tasks,
  };
}

function buildTasksAuditJsonPayload(opts: TasksAuditJsonArgs) {
  const severityFilter = parseCliEnumFilter(
    opts.severity,
    "--severity",
    TASK_SYSTEM_AUDIT_SEVERITIES,
  ) as TaskSystemAuditSeverity | undefined;
  const codeFilter = parseCliEnumFilter(opts.code, "--code", TASK_SYSTEM_AUDIT_CODES) as
    | TaskSystemAuditCode
    | undefined;
  const result = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  return buildTaskSystemAuditJsonPayload(result, {
    severityFilter,
    codeFilter,
    limit: opts.limit,
  });
}

/** Writes task list JSON without triggering task maintenance. */
export async function tasksListJsonCommand(
  opts: TasksListJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}

/** Writes task audit JSON with combined task/task-flow findings. */
export async function tasksAuditJsonCommand(
  opts: TasksAuditJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}
