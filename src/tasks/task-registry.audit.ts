import { reconcileInspectableTasks } from "./task-registry.reconcile.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskAuditSeverity = "warn" | "error";
export type TaskAuditCode =
  | "stale_queued"
  | "stale_running"
  | "lost"
  | "delivery_failed"
  | "missing_cleanup"
  | "inconsistent_timestamps";

export type TaskAuditFinding = {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  ageMs?: number;
  detail: string;
};

export type TaskAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskAuditCode, number>;
};

export type TaskAuditOptions = {
  now?: number;
  tasks?: TaskRecord[];
  staleQueuedMs?: number;
  staleRunningMs?: number;
};

const DEFAULT_STALE_QUEUED_MS = 10 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;

function createEmptyTaskAuditSummary(): TaskAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 0,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  };
}

function createFinding(params: {
  severity: TaskAuditSeverity;
  code: TaskAuditCode;
  task: TaskRecord;
  detail: string;
  ageMs?: number;
}): TaskAuditFinding {
  return {
    severity: params.severity,
    code: params.code,
    task: params.task,
    detail: params.detail,
    ...(typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {}),
  };
}

function taskReferenceAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function findTimestampInconsistency(task: TaskRecord): TaskAuditFinding | null {
  if (task.startedAt && task.startedAt < task.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: "startedAt is earlier than createdAt",
    });
  }
  if (task.endedAt && task.startedAt && task.endedAt < task.startedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: "endedAt is earlier than startedAt",
    });
  }
  if ((task.status === "queued" || task.status === "running") && task.endedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      task,
      detail: `${task.status} task should not already have endedAt`,
    });
  }
  return null;
}

function compareFindings(left: TaskAuditFinding, right: TaskAuditFinding): number {
  const severityRank = (severity: TaskAuditSeverity) => (severity === "error" ? 0 : 1);
  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  const leftAge = left.ageMs ?? -1;
  const rightAge = right.ageMs ?? -1;
  if (leftAge !== rightAge) {
    return rightAge - leftAge;
  }
  return left.task.createdAt - right.task.createdAt;
}

export function listTaskAuditFindings(options: TaskAuditOptions = {}): TaskAuditFinding[] {
  const tasks = options.tasks ?? reconcileInspectableTasks();
  const now = options.now ?? Date.now();
  const staleQueuedMs = options.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS;
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const findings: TaskAuditFinding[] = [];

  for (const task of tasks) {
    const referenceAt = taskReferenceAt(task);
    const ageMs = Math.max(0, now - referenceAt);

    if (task.status === "queued" && ageMs >= staleQueuedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_queued",
          task,
          ageMs,
          detail: "queued task has not advanced recently",
        }),
      );
    }

    if (task.status === "running" && ageMs >= staleRunningMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "stale_running",
          task,
          ageMs,
          detail: "running task appears stuck",
        }),
      );
    }

    if (task.status === "lost") {
      findings.push(
        createFinding({
          severity: "error",
          code: "lost",
          task,
          ageMs,
          detail: task.error?.trim() || "task lost its backing session",
        }),
      );
    }

    if (task.deliveryStatus === "failed" && task.notifyPolicy !== "silent") {
      findings.push(
        createFinding({
          severity: "warn",
          code: "delivery_failed",
          task,
          ageMs,
          detail: "terminal update delivery failed",
        }),
      );
    }

    if (
      task.status !== "queued" &&
      task.status !== "running" &&
      typeof task.cleanupAfter !== "number"
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "missing_cleanup",
          task,
          ageMs,
          detail: "terminal task is missing cleanupAfter",
        }),
      );
    }

    const inconsistency = findTimestampInconsistency(task);
    if (inconsistency) {
      findings.push(inconsistency);
    }
  }

  return findings.toSorted(compareFindings);
}

export function summarizeTaskAuditFindings(findings: Iterable<TaskAuditFinding>): TaskAuditSummary {
  const summary = createEmptyTaskAuditSummary();
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] += 1;
    if (finding.severity === "error") {
      summary.errors += 1;
    } else {
      summary.warnings += 1;
    }
  }
  return summary;
}
