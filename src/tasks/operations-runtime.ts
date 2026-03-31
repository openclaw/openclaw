import type {
  PluginOperationAuditFinding,
  PluginOperationAuditQuery,
  PluginOperationDispatchEvent,
  PluginOperationDispatchResult,
  PluginOperationListQuery,
  PluginOperationMaintenanceQuery,
  PluginOperationMaintenanceSummary,
  PluginOperationRecord,
  PluginOperationSummary,
  PluginOperationsCancelResult,
  PluginOperationsRuntime,
} from "../plugins/operations-state.js";
import { summarizeOperationRecords } from "../plugins/operations-state.js";
import {
  listTaskAuditFindings,
  type TaskAuditFinding,
  type TaskAuditSeverity,
} from "./task-registry.audit.js";
import {
  cancelTaskById,
  createTaskRecord,
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
  listTasksForSessionKey,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalByRunId,
  recordTaskProgressByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import type {
  TaskRecord,
  TaskRuntime,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const TASK_NAMESPACE = "tasks";

function isTaskNamespace(namespace: string | undefined): boolean {
  const trimmed = namespace?.trim().toLowerCase();
  return !trimmed || trimmed === "task" || trimmed === TASK_NAMESPACE;
}

function normalizeTaskRuntime(kind: string): TaskRuntime {
  const trimmed = kind.trim();
  if (trimmed === "acp" || trimmed === "subagent" || trimmed === "cli" || trimmed === "cron") {
    return trimmed;
  }
  throw new Error(`Unsupported task operation kind: ${kind}`);
}

function normalizeTaskStatus(status: string | undefined): TaskStatus {
  const trimmed = status?.trim();
  if (
    trimmed === "queued" ||
    trimmed === "running" ||
    trimmed === "succeeded" ||
    trimmed === "failed" ||
    trimmed === "timed_out" ||
    trimmed === "cancelled" ||
    trimmed === "lost"
  ) {
    return trimmed;
  }
  return "queued";
}

function normalizeTaskTerminalOutcome(status: TaskStatus): TaskTerminalOutcome | undefined {
  return status === "succeeded" ? "succeeded" : undefined;
}

function toOperationRecord(task: TaskRecord): PluginOperationRecord {
  const metadata: Record<string, unknown> = {
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
  };
  if (typeof task.cleanupAfter === "number") {
    metadata.cleanupAfter = task.cleanupAfter;
  }
  if (task.terminalOutcome) {
    metadata.terminalOutcome = task.terminalOutcome;
  }
  return {
    operationId: task.taskId,
    namespace: TASK_NAMESPACE,
    kind: task.runtime,
    status: task.status,
    sourceId: task.sourceId,
    requesterSessionKey: task.requesterSessionKey,
    childSessionKey: task.childSessionKey,
    parentOperationId: task.parentTaskId,
    agentId: task.agentId,
    runId: task.runId,
    title: task.label,
    description: task.task,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    updatedAt: task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt,
    error: task.error,
    progressSummary: task.progressSummary,
    terminalSummary: task.terminalSummary,
    metadata,
  };
}

function resolveTaskRecordForTransition(event: {
  operationId?: string;
  runId?: string;
}): TaskRecord | undefined {
  const operationId = event.operationId?.trim();
  if (operationId) {
    return getTaskById(operationId);
  }
  const runId = event.runId?.trim();
  if (runId) {
    return findTaskByRunId(runId);
  }
  return undefined;
}

function filterOperationRecord(
  record: PluginOperationRecord,
  query: PluginOperationListQuery,
): boolean {
  if (query.namespace && !isTaskNamespace(query.namespace)) {
    return false;
  }
  if (query.kind && record.kind !== query.kind) {
    return false;
  }
  if (query.status && record.status !== query.status) {
    return false;
  }
  if (query.runId && record.runId !== query.runId) {
    return false;
  }
  if (query.sourceId && record.sourceId !== query.sourceId) {
    return false;
  }
  if (query.parentOperationId && record.parentOperationId !== query.parentOperationId) {
    return false;
  }
  if (
    query.sessionKey &&
    record.requesterSessionKey !== query.sessionKey &&
    record.childSessionKey !== query.sessionKey
  ) {
    return false;
  }
  return true;
}

async function dispatchTaskOperation(
  event: PluginOperationDispatchEvent,
): Promise<PluginOperationDispatchResult> {
  if (event.type === "create") {
    if (!isTaskNamespace(event.namespace)) {
      throw new Error(
        `Default operations runtime only supports the "${TASK_NAMESPACE}" namespace.`,
      );
    }
    const status = normalizeTaskStatus(event.status);
    const record = createTaskRecord({
      runtime: normalizeTaskRuntime(event.kind),
      sourceId: event.sourceId,
      requesterSessionKey: event.requesterSessionKey?.trim() || "",
      childSessionKey: event.childSessionKey,
      parentTaskId: event.parentOperationId,
      agentId: event.agentId,
      runId: event.runId,
      label: event.title,
      task: event.description,
      status,
      startedAt: event.startedAt,
      lastEventAt: event.updatedAt ?? event.startedAt ?? event.createdAt,
      progressSummary: event.progressSummary,
      terminalSummary: event.terminalSummary,
      terminalOutcome: normalizeTaskTerminalOutcome(status),
    });
    return {
      matched: true,
      created: true,
      record: toOperationRecord(record),
    };
  }

  if (event.type === "patch") {
    const current = resolveTaskRecordForTransition(event);
    if (!current) {
      return {
        matched: false,
        record: null,
      };
    }
    const nextNotifyPolicy = event.metadataPatch?.notifyPolicy;
    const next =
      nextNotifyPolicy === "done_only" ||
      nextNotifyPolicy === "state_changes" ||
      nextNotifyPolicy === "silent"
        ? (updateTaskNotifyPolicyById({
            taskId: current.taskId,
            notifyPolicy: nextNotifyPolicy,
          }) ?? current)
        : current;
    return {
      matched: true,
      record: toOperationRecord(next),
    };
  }

  const current = resolveTaskRecordForTransition(event);
  if (!current) {
    return {
      matched: false,
      record: null,
    };
  }

  const at = event.at ?? event.endedAt ?? event.startedAt ?? Date.now();
  const runId = event.runId?.trim() || current.runId?.trim();
  const status = normalizeTaskStatus(event.status);
  let next: TaskRecord | null | undefined;

  if (status === "running") {
    if (!runId) {
      throw new Error("Task transition to running requires a runId.");
    }
    next = markTaskRunningByRunId({
      runId,
      startedAt: event.startedAt,
      lastEventAt: at,
      progressSummary: event.progressSummary,
      eventSummary: event.progressSummary,
    })[0];
  } else if (status === "queued") {
    if (!runId) {
      throw new Error("Task transition to queued requires a runId.");
    }
    next = recordTaskProgressByRunId({
      runId,
      lastEventAt: at,
      progressSummary: event.progressSummary,
      eventSummary: event.progressSummary,
    })[0];
  } else if (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  ) {
    if (!runId) {
      throw new Error(`Task transition to ${status} requires a runId.`);
    }
    next = markTaskTerminalByRunId({
      runId,
      status,
      startedAt: event.startedAt,
      endedAt: event.endedAt ?? at,
      lastEventAt: at,
      error: event.error ?? undefined,
      progressSummary: event.progressSummary,
      terminalSummary: event.terminalSummary,
      terminalOutcome: status === "succeeded" ? "succeeded" : undefined,
    })[0];
  } else if (status === "lost") {
    next = markTaskLostById({
      taskId: current.taskId,
      endedAt: event.endedAt ?? at,
      lastEventAt: at,
      error: event.error ?? undefined,
    });
  }

  return {
    matched: true,
    record: next ? toOperationRecord(next) : toOperationRecord(current),
  };
}

async function getTaskOperationList(
  query: PluginOperationListQuery = {},
): Promise<PluginOperationRecord[]> {
  if (query.namespace && !isTaskNamespace(query.namespace)) {
    return [];
  }
  const records = (
    query.sessionKey ? listTasksForSessionKey(query.sessionKey) : listTaskRecords()
  ).map(toOperationRecord);
  const filtered = records.filter((record) => filterOperationRecord(record, query));
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
      ? Math.floor(query.limit)
      : undefined;
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function isMatchingTaskAuditSeverity(
  actual: TaskAuditSeverity,
  requested: PluginOperationAuditQuery["severity"],
): boolean {
  return !requested || actual === requested;
}

function toOperationAuditFinding(finding: TaskAuditFinding): PluginOperationAuditFinding {
  return {
    severity: finding.severity,
    code: finding.code,
    operation: toOperationRecord(finding.task),
    detail: finding.detail,
    ...(typeof finding.ageMs === "number" ? { ageMs: finding.ageMs } : {}),
  };
}

async function auditTaskOperations(
  query: PluginOperationAuditQuery = {},
): Promise<PluginOperationAuditFinding[]> {
  if (query.namespace && !isTaskNamespace(query.namespace)) {
    return [];
  }
  return listTaskAuditFindings()
    .filter((finding) => {
      if (!isMatchingTaskAuditSeverity(finding.severity, query.severity)) {
        return false;
      }
      if (query.code && finding.code !== query.code) {
        return false;
      }
      return true;
    })
    .map(toOperationAuditFinding);
}

async function maintainTaskOperations(
  query: PluginOperationMaintenanceQuery = {},
): Promise<PluginOperationMaintenanceSummary> {
  if (query.namespace && !isTaskNamespace(query.namespace)) {
    return {
      reconciled: 0,
      cleanupStamped: 0,
      pruned: 0,
    };
  }
  return query.apply ? runTaskRegistryMaintenance() : previewTaskRegistryMaintenance();
}

export const defaultTaskOperationsRuntime: PluginOperationsRuntime = {
  dispatch: dispatchTaskOperation,
  async getById(operationId: string) {
    const record = getTaskById(operationId.trim());
    return record ? toOperationRecord(record) : null;
  },
  async findByRunId(runId: string) {
    const record = findTaskByRunId(runId.trim());
    return record ? toOperationRecord(record) : null;
  },
  list: getTaskOperationList,
  async summarize(query) {
    const records = await getTaskOperationList(query);
    return summarizeOperationRecords(records);
  },
  audit: auditTaskOperations,
  maintenance: maintainTaskOperations,
  async cancel(params): Promise<PluginOperationsCancelResult> {
    const result = await cancelTaskById({
      cfg: params.cfg,
      taskId: params.operationId,
    });
    return {
      found: result.found,
      cancelled: result.cancelled,
      reason: result.reason,
      record: result.task ? toOperationRecord(result.task) : null,
    };
  },
};

export async function summarizeTaskOperations(
  query: PluginOperationListQuery = {},
): Promise<PluginOperationSummary> {
  return defaultTaskOperationsRuntime.summarize(query);
}
