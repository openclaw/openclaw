// Builds task status summaries and formatted status text for user-facing surfaces.
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { truncateUtf16Safe } from "../utils.js";
import { matchesTaskStatusFilter, type TaskRecord } from "./task-registry.types.js";

const FAILURE_TASK_STATUSES = new Set(["failed", "timed_out", "lost", "blocked"]);
/** Window for showing recently completed tasks in compact status output. */
const TASK_STATUS_RECENT_WINDOW_MS = 5 * 60_000;
const TASK_STATUS_TITLE_MAX_CHARS = 80;
export const TASK_STATUS_DETAIL_MAX_CHARS = 120;

export function formatTaskStatus(task: Pick<TaskRecord, "status" | "terminalOutcome">) {
  return matchesTaskStatusFilter(task, "blocked") ? "blocked" : task.status;
}

export function isTaskStatusIssue(task: Pick<TaskRecord, "status" | "terminalOutcome">): boolean {
  return FAILURE_TASK_STATUSES.has(formatTaskStatus(task));
}

/** Applies a task display limit to text that its caller has already sanitized. */
export function truncateTaskStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripInlineLeakedInternalContext(value: string): string {
  // Completion text can accidentally include hidden runtime context; strip it before status output.
  const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  if (
    beginIndex !== -1 &&
    (value.includes(INTERNAL_RUNTIME_CONTEXT_END) ||
      value.includes("OpenClaw runtime context (internal):") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, beginIndex);
  }
  const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
  if (
    legacyHeaderIndex !== -1 &&
    (value.includes("Keep internal details private.") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, legacyHeaderIndex);
  }
  return value;
}

function sanitizeTaskStatusValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = renderUserFacingText(stripInlineLeakedInternalContext(value), {
      errorContext,
    })
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeTaskStatusValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeTaskStatusValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

export function sanitizeTaskStatusText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const errorContext = opts?.errorContext ?? false;
  const sanitizedValue = sanitizeTaskStatusValue(value, errorContext);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateTaskStatusText(sanitized, opts.maxChars);
  }
  return sanitized;
}

/** Explicit task lookups retain the sanitized input; list/event titles stay bounded. */
export function sanitizeTaskPromptText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // Task input is source, not assistant prose: deduplication and tag cleanup
  // would change repeated commands or literal shell arguments.
  return stripInlineLeakedInternalContext(
    stripInternalRuntimeContext(value, { preserveSurroundingWhitespace: true }),
  ).trim();
}

export function formatTaskStatusTitleText(value: unknown, fallback = "Background task"): string {
  return sanitizeTaskStatusText(value, { maxChars: TASK_STATUS_TITLE_MAX_CHARS }) || fallback;
}

export function formatTaskStatusTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(task.label?.trim() || task.task.trim());
}

export function formatTaskStatusDetail(task: TaskRecord): string | undefined {
  if (task.status === "running" || task.status === "queued") {
    return (
      sanitizeTaskStatusText(task.progressSummary, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }) ||
      undefined
    );
  }

  const sanitizedError = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  if (sanitizedError) {
    return sanitizedError;
  }

  return (
    sanitizeTaskStatusText(task.terminalSummary, {
      errorContext: true,
      maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
    }) || undefined
  );
}

type TaskStatusSnapshot = {
  latest?: TaskRecord;
  focus?: TaskRecord;
  visible: TaskRecord[];
  active: TaskRecord[];
  recentTerminal: TaskRecord[];
  activeCount: number;
  totalCount: number;
  recentFailureCount: number;
};

export function buildTaskStatusSnapshot(
  tasks: TaskRecord[],
  opts?: { now?: number },
): TaskStatusSnapshot {
  const now = opts?.now ?? Date.now();
  const active: TaskRecord[] = [];
  const recentTerminal: TaskRecord[] = [];
  let firstIssue: TaskRecord | undefined;
  let recentFailureCount = 0;
  for (const task of tasks) {
    if (typeof task.cleanupAfter === "number" && task.cleanupAfter <= now) {
      continue;
    }
    if (task.status === "queued" || task.status === "running") {
      active.push(task);
      continue;
    }
    const referenceAt = task.endedAt ?? task.lastEventAt ?? task.startedAt ?? task.createdAt;
    if (now - referenceAt <= TASK_STATUS_RECENT_WINDOW_MS) {
      recentTerminal.push(task);
      if (isTaskStatusIssue(task)) {
        firstIssue ??= task;
        recentFailureCount += 1;
      }
    }
  }
  const visible = active.length > 0 ? [...active, ...recentTerminal] : recentTerminal;
  const focus = active[0] ?? firstIssue ?? recentTerminal[0];
  return {
    latest: active[0] ?? recentTerminal[0],
    focus,
    visible,
    active,
    recentTerminal,
    activeCount: active.length,
    totalCount: visible.length,
    recentFailureCount,
  };
}
