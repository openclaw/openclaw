// Produces task-flow registry audit summaries for diagnostics and maintenance.
import { listTaskStatesForFlowIds } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import type {
  TaskFlowAuditCode,
  TaskFlowAuditFinding,
  TaskFlowAuditSeverity,
  TaskFlowAuditSummary,
} from "./task-flow-registry.audit.types.js";
import { getTaskFlowRegistryRestoreFailure, listTaskFlowRecords } from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  compareTaskAuditFindingSortKeys,
  summarizeAuditFindings,
} from "./task-registry.audit.shared.js";

export type {
  TaskFlowAuditFinding,
  TaskFlowAuditSummary,
} from "./task-flow-registry.audit.types.js";

type TaskFlowAuditOptions = {
  now?: number;
  flows?: TaskFlowRecord[];
  staleRunningMs?: number;
  staleWaitingMs?: number;
  staleBlockedMs?: number;
  cancelStuckMs?: number;
};

const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;
const DEFAULT_STALE_WAITING_MS = 30 * 60_000;
const DEFAULT_STALE_BLOCKED_MS = 30 * 60_000;
const DEFAULT_CANCEL_STUCK_MS = 5 * 60_000;

function createFinding(params: {
  severity: TaskFlowAuditSeverity;
  code: TaskFlowAuditCode;
  detail: string;
  ageMs?: number;
  flow?: TaskFlowRecord;
}): TaskFlowAuditFinding {
  return {
    severity: params.severity,
    code: params.code,
    detail: params.detail,
    ...(typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {}),
    ...(params.flow ? { flow: params.flow } : {}),
  };
}

function compareFindings(left: TaskFlowAuditFinding, right: TaskFlowAuditFinding): number {
  return compareTaskAuditFindingSortKeys(
    { ...left, createdAt: left.flow?.createdAt ?? 0 },
    { ...right, createdAt: right.flow?.createdAt ?? 0 },
  );
}

function hasBlockingMetadata(flow: TaskFlowRecord): boolean {
  return Boolean(
    flow.blockedTaskId?.trim() || flow.blockedSummary?.trim() || flow.waitJson != null,
  );
}

function findTimestampInconsistency(flow: TaskFlowRecord): TaskFlowAuditFinding | null {
  const detail =
    flow.updatedAt < flow.createdAt
      ? "updatedAt is earlier than createdAt"
      : flow.endedAt && flow.endedAt < flow.createdAt
        ? "endedAt is earlier than createdAt"
        : flow.endedAt && flow.endedAt < flow.updatedAt
          ? "endedAt is earlier than updatedAt"
          : undefined;
  return detail
    ? createFinding({
        severity: "warn",
        code: "inconsistent_timestamps",
        flow,
        detail,
      })
    : null;
}

function createEmptyTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      restore_failed: 0,
      stale_running: 0,
      stale_waiting: 0,
      stale_blocked: 0,
      cancel_stuck: 0,
      missing_linked_tasks: 0,
      blocked_task_missing: 0,
      inconsistent_timestamps: 0,
    },
  };
}

export function listTaskFlowAuditFindings(
  options: TaskFlowAuditOptions = {},
): TaskFlowAuditFinding[] {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  const flows = options.flows ?? (restoreFailure ? [] : listTaskFlowRecords());
  const now = options.now ?? Date.now();
  const staleThresholds = {
    running: options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS,
    waiting: options.staleWaitingMs ?? DEFAULT_STALE_WAITING_MS,
    blocked: options.staleBlockedMs ?? DEFAULT_STALE_BLOCKED_MS,
  };
  const cancelStuckMs = options.cancelStuckMs ?? DEFAULT_CANCEL_STUCK_MS;
  const findings: TaskFlowAuditFinding[] = [];

  if (restoreFailure) {
    findings.push(
      createFinding({
        severity: "error",
        code: "restore_failed",
        detail: `task-flow registry restore failed: ${restoreFailure}`,
      }),
    );
  }

  const tasksByFlowId =
    flows.length > 0 ? listTaskStatesForFlowIds(flows.map((flow) => flow.flowId)) : undefined;
  for (const flow of flows) {
    const referenceAt = flow.updatedAt ?? flow.createdAt;
    const ageMs = Math.max(0, now - referenceAt);
    const linkedTasks = tasksByFlowId?.get(flow.flowId.trim()) ?? [];
    const hasActiveTasks = linkedTasks.some(isTaskFlowCancellationPending);

    const stale =
      (flow.status === "running" || flow.status === "waiting" || flow.status === "blocked") &&
      ageMs >= staleThresholds[flow.status]
        ? flow.status
        : undefined;
    if (stale && (stale !== "blocked" || flow.endedAt == null)) {
      findings.push(
        createFinding({
          severity: stale === "running" ? "error" : "warn",
          code: `stale_${stale}`,
          flow,
          ageMs,
          detail: `${stale} TaskFlow has not advanced recently`,
        }),
      );
    }

    if (
      flow.cancelRequestedAt != null &&
      flow.status !== "cancelled" &&
      flow.status !== "failed" &&
      flow.status !== "succeeded" &&
      flow.status !== "lost" &&
      !hasActiveTasks &&
      now - flow.cancelRequestedAt >= cancelStuckMs
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "cancel_stuck",
          flow,
          ageMs: Math.max(0, now - flow.cancelRequestedAt),
          detail: "cancel-requested TaskFlow has no active child tasks but is still nonterminal",
        }),
      );
    }

    if (
      flow.syncMode === "managed" &&
      stale &&
      linkedTasks.length === 0 &&
      !hasBlockingMetadata(flow)
    ) {
      findings.push(
        createFinding({
          severity: flow.status === "running" ? "error" : "warn",
          code: "missing_linked_tasks",
          flow,
          ageMs,
          detail: "managed TaskFlow has no linked tasks or wait state",
        }),
      );
    }

    if (flow.endedAt == null && flow.blockedTaskId?.trim()) {
      const blockedTaskId = flow.blockedTaskId.trim();
      if (!linkedTasks.some((task) => task.taskId === blockedTaskId)) {
        findings.push(
          createFinding({
            severity: "warn",
            code: "blocked_task_missing",
            flow,
            ageMs,
            detail: `blocked TaskFlow points at missing task ${blockedTaskId}`,
          }),
        );
      }
    }

    const inconsistency = findTimestampInconsistency(flow);
    if (inconsistency) {
      findings.push(inconsistency);
    }
  }

  return findings.toSorted(compareFindings);
}

export function summarizeTaskFlowAuditFindings(
  findings: Iterable<TaskFlowAuditFinding>,
): TaskFlowAuditSummary {
  return summarizeAuditFindings(findings, createEmptyTaskFlowAuditSummary());
}
