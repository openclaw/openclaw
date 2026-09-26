// Produces task registry audit summaries for diagnostics and maintenance.
import {
  compareTaskAuditFindingSortKeys,
  createEmptyTaskAuditSummary,
  summarizeAuditFindings,
  type TaskAuditCode,
  type TaskAuditFinding,
  type TaskAuditSeverity,
  type TaskAuditSummary,
} from "./task-registry.audit.shared.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

type TaskAuditOptions = {
  now?: number;
  tasks?: TaskRecord[];
  staleQueuedMs?: number;
  staleRunningMs?: number;
};

export type TaskAuditRecord = Pick<
  TaskRecord,
  | "status"
  | "deliveryStatus"
  | "notifyPolicy"
  | "createdAt"
  | "startedAt"
  | "endedAt"
  | "lastEventAt"
  | "cleanupAfter"
>;

export type RetainedLostTaskAuditSummary = {
  count: number;
  nextCleanupAfter?: number;
};

const DEFAULT_STALE_QUEUED_MS = 10 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;
export type { TaskAuditFinding, TaskAuditSummary };

let taskAuditTaskProvider: () => TaskRecord[] = () => [];

/** Installs the task source used by inspectable task audits. */
export function configureTaskAuditTaskProvider(provider: () => TaskRecord[]): void {
  taskAuditTaskProvider = provider;
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

function taskReferenceAt(task: TaskAuditRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

type TaskTimestampInconsistency = "start_before_creation" | "end_before_start" | "active_ended";

function findTimestampInconsistency(task: TaskAuditRecord): TaskTimestampInconsistency | null {
  if (task.startedAt && task.startedAt < task.createdAt) {
    return "start_before_creation";
  }
  if (task.endedAt && task.startedAt && task.endedAt < task.startedAt) {
    return "end_before_start";
  }
  if ((task.status === "queued" || task.status === "running") && task.endedAt) {
    return "active_ended";
  }
  return null;
}

function retainedLostCleanupAfter(task: TaskAuditRecord, now: number): number | undefined {
  if (task.status !== "lost" || typeof task.cleanupAfter !== "number") {
    return undefined;
  }
  const cleanupAfter = resolveEffectiveTaskCleanupAfter(task);
  return cleanupAfter > now ? cleanupAfter : undefined;
}

function visitTaskAuditCodes(
  task: TaskAuditRecord,
  now: number,
  visit: (
    code: TaskAuditCode,
    severity: TaskAuditSeverity,
    ageMs?: number,
    timestampIssue?: TaskTimestampInconsistency,
  ) => void,
  staleQueuedMs = DEFAULT_STALE_QUEUED_MS,
  staleRunningMs = DEFAULT_STALE_RUNNING_MS,
): void {
  const ageMs = Math.max(0, now - taskReferenceAt(task));
  if (task.status === "queued" && ageMs >= staleQueuedMs) {
    visit("stale_queued", "warn", ageMs);
  }
  if (task.status === "running" && ageMs >= staleRunningMs) {
    visit("stale_running", "error", ageMs);
  }
  if (task.status === "lost") {
    visit("lost", retainedLostCleanupAfter(task, now) !== undefined ? "warn" : "error", ageMs);
  }
  if (task.deliveryStatus === "failed" && task.notifyPolicy !== "silent") {
    visit("delivery_failed", "warn", ageMs);
  }
  if (
    task.status !== "lost" &&
    task.status !== "queued" &&
    task.status !== "running" &&
    typeof task.cleanupAfter !== "number"
  ) {
    visit("missing_cleanup", "warn", ageMs);
  }
  const inconsistency = findTimestampInconsistency(task);
  if (inconsistency) {
    visit("inconsistent_timestamps", "warn", undefined, inconsistency);
  }
}

const TASK_AUDIT_DESCRIPTIONS: Record<
  Exclude<TaskAuditCode, "lost" | "inconsistent_timestamps">,
  string
> = {
  stale_queued: "queued task has not advanced recently",
  stale_running: "running task appears stuck",
  delivery_failed: "terminal update delivery failed",
  missing_cleanup: "terminal task is missing cleanupAfter",
};

function describeTaskAuditCode(
  task: TaskRecord,
  code: TaskAuditCode,
  severity: TaskAuditSeverity,
  timestampIssue?: TaskTimestampInconsistency,
): string {
  if (code === "lost") {
    return (
      task.error?.trim() ||
      (severity === "warn"
        ? "task lost its backing session and is retained until cleanupAfter"
        : "task lost its backing session")
    );
  }
  if (code === "inconsistent_timestamps") {
    return timestampIssue === "start_before_creation"
      ? "startedAt is earlier than createdAt"
      : timestampIssue === "end_before_start"
        ? "endedAt is earlier than startedAt"
        : `${task.status} task should not already have endedAt`;
  }
  return TASK_AUDIT_DESCRIPTIONS[code];
}

function compareFindings(left: TaskAuditFinding, right: TaskAuditFinding): number {
  return compareTaskAuditFindingSortKeys(
    {
      severity: left.severity,
      ageMs: left.ageMs,
      createdAt: left.task.createdAt,
    },
    {
      severity: right.severity,
      ageMs: right.ageMs,
      createdAt: right.task.createdAt,
    },
  );
}

export function listTaskAuditFindings(options: TaskAuditOptions = {}): TaskAuditFinding[] {
  const tasks = options.tasks ?? taskAuditTaskProvider();
  const now = options.now ?? Date.now();
  const staleQueuedMs = options.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS;
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const findings: TaskAuditFinding[] = [];

  for (const task of tasks) {
    visitTaskAuditCodes(
      task,
      now,
      (code, severity, ageMs, timestampIssue) => {
        findings.push(
          createFinding({
            code,
            severity,
            task,
            ageMs,
            detail: describeTaskAuditCode(task, code, severity, timestampIssue),
          }),
        );
      },
      staleQueuedMs,
      staleRunningMs,
    );
  }

  return findings.toSorted(compareFindings);
}

function isRetainedLostTaskAuditFinding(finding: TaskAuditFinding, now = Date.now()): boolean {
  return finding.code === "lost" && retainedLostCleanupAfter(finding.task, now) !== undefined;
}

/** Folds audit metadata without materializing findings; returns whether this lost task is retained. */
export function addTaskAuditRecordSummary(
  summary: TaskAuditSummary,
  retainedLost: RetainedLostTaskAuditSummary,
  task: TaskAuditRecord,
  now: number,
): boolean {
  const cleanupAfter = retainedLostCleanupAfter(task, now);
  if (cleanupAfter !== undefined) {
    retainedLost.count += 1;
    retainedLost.nextCleanupAfter =
      retainedLost.nextCleanupAfter === undefined
        ? cleanupAfter
        : Math.min(retainedLost.nextCleanupAfter, cleanupAfter);
  }
  visitTaskAuditCodes(task, now, (code, severity) => {
    if (code === "lost" && cleanupAfter !== undefined) {
      return;
    }
    summary.total += 1;
    summary.byCode[code] += 1;
    if (severity === "error") {
      summary.errors += 1;
    } else {
      summary.warnings += 1;
    }
  });
  return cleanupAfter !== undefined;
}

export function summarizeTaskAuditFindings(findings: Iterable<TaskAuditFinding>): TaskAuditSummary {
  return summarizeAuditFindings(findings, createEmptyTaskAuditSummary());
}

export function summarizeRetainedLostTaskAuditFindings(
  findings: Iterable<TaskAuditFinding>,
  options: { now?: number } = {},
): RetainedLostTaskAuditSummary {
  const now = options.now ?? Date.now();
  let count = 0;
  let nextCleanupAfter: number | undefined;
  for (const finding of findings) {
    if (!isRetainedLostTaskAuditFinding(finding, now)) {
      continue;
    }
    count += 1;
    const cleanupAfter = resolveEffectiveTaskCleanupAfter(finding.task);
    if (nextCleanupAfter === undefined || cleanupAfter < nextCleanupAfter) {
      nextCleanupAfter = cleanupAfter;
    }
  }
  return {
    count,
    ...(nextCleanupAfter !== undefined ? { nextCleanupAfter } : {}),
  };
}
