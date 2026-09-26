import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as optionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Value } from "typebox/value";
import {
  TasksCancelResultSchema,
  TasksGetResultSchema,
  TasksListResultSchema,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import type { TasksCancelResult } from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../format-duration.ts";
import { normalizeTaskSummary, type TaskStatus, type TaskSummary } from "./task-summary.ts";

type TaskTimestamp = NonNullable<TaskSummary["updatedAt"]>;

type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };

export type CoalescedTaskEvent =
  | { action: "deleted" }
  | { action: "upserted"; task: TaskSummary; afterDelete: boolean };

const STATUS_LABEL_KEYS = {
  queued: "tasksPage.status.queued",
  running: "tasksPage.status.running",
  completed: "tasksPage.status.completed",
  failed: "tasksPage.status.failed",
  cancelled: "tasksPage.status.cancelled",
  timed_out: "tasksPage.status.timedOut",
} as const satisfies Record<TaskStatus, string>;

export function taskStatusLabel(status: TaskStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export function taskRuntimeLabel(task: TaskSummary): string {
  switch (task.runtime) {
    case "subagent":
      return t("tasksPage.runtime.subagent");
    case "cron":
      return t("tasksPage.runtime.cron");
    case "acp":
      return t("tasksPage.runtime.acp");
    case "cli":
      return t("tasksPage.runtime.cli");
    default:
      return t("tasksPage.runtime.unknown");
  }
}

export function taskTitle(task: TaskSummary): string {
  return (
    task.title ?? task.kind ?? (task.runtime ? taskRuntimeLabel(task) : t("tasksPage.untitled"))
  );
}

export function taskDisplayTitle(task: TaskSummary, detail?: TaskSummary): string {
  if (task.title != null || task.kind != null) {
    return taskTitle(task);
  }
  const prompt = (detail?.prompt ?? task.prompt)?.split(/\r?\n/).find((line) => line.trim());
  const title = prompt?.trim() || task.progressSummary?.trim();
  return title
    ? title.length > 120
      ? `${truncateUtf16Safe(title, 119)}…`
      : title
    : taskTitle(task);
}

export function taskFinishedDuration(task: TaskSummary): string | undefined {
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  const endedMs = taskTimestampMs(task.endedAt);
  return !isActiveTask(task) && endedMs > startedMs && startedMs > 0
    ? formatDurationCompact(endedMs - startedMs)
    : undefined;
}

export function taskDetail(task: TaskSummary): string | null {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? null;
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return task.error ?? task.terminalSummary ?? task.progressSummary ?? null;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? null;
}

export function isActiveTask(task: TaskSummary): boolean {
  return task.status === "queued" || task.status === "running";
}

export function taskTimestampMs(value: TaskTimestamp | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

type TaskSnapshotProvenance = "snapshot" | "event" | "detail";

function preserveTaskPrompt(
  selected: TaskSummary,
  current: TaskSummary,
  lookup: TaskSummary,
): TaskSummary {
  const prompt = lookup.prompt ?? current.prompt;
  return prompt && selected.prompt !== prompt ? { ...selected, prompt } : selected;
}

export function newestTaskSnapshot(
  current: TaskSummary,
  lookup: TaskSummary | undefined,
  provenance: TaskSnapshotProvenance = "detail",
): TaskSummary {
  if (!lookup) {
    return current;
  }
  const currentAt = taskTimestampMs(current.updatedAt ?? current.endedAt ?? current.createdAt);
  const lookupAt = taskTimestampMs(lookup.updatedAt ?? lookup.endedAt ?? lookup.createdAt);
  if (lookupAt > currentAt) {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  if (lookupAt < currentAt) {
    return current;
  }
  // Millisecond clocks collide under load. Ordered pages and events advance
  // active work; only events correct terminal output, and details stay stale-safe.
  const currentActive = isActiveTask(current);
  const lookupActive = isActiveTask(lookup);
  if (currentActive !== lookupActive) {
    return preserveTaskPrompt(currentActive ? lookup : current, current, lookup);
  }
  if (!currentActive) {
    return provenance === "event" ? preserveTaskPrompt(lookup, current, lookup) : current;
  }
  if (current.status === "running" && lookup.status === "queued") {
    return preserveTaskPrompt(current, current, lookup);
  }
  if (current.status === "queued" && lookup.status === "running") {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  // Execution observations can advance while the durable lifecycle clock stays fixed.
  const currentActivityAt = taskTimestampMs(current.execution?.lastActivityAt);
  const lookupActivityAt = taskTimestampMs(lookup.execution?.lastActivityAt);
  if (lookupActivityAt !== currentActivityAt) {
    return preserveTaskPrompt(
      lookupActivityAt > currentActivityAt ? lookup : current,
      current,
      lookup,
    );
  }
  const currentToolCount = current.toolUseCount ?? 0;
  const lookupToolCount = lookup.toolUseCount ?? 0;
  if (currentToolCount > lookupToolCount) {
    return preserveTaskPrompt(current, current, lookup);
  }
  if (lookupToolCount > currentToolCount || provenance !== "detail") {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  return preserveTaskPrompt(current, current, lookup);
}

export function sortTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.toSorted((left, right) => {
    // Activity keeps live work visible without changing snapshot lifecycle authority.
    const leftAt = Math.max(
      taskTimestampMs(left.updatedAt),
      isActiveTask(left) ? taskTimestampMs(left.execution?.lastActivityAt) : 0,
    );
    const rightAt = Math.max(
      taskTimestampMs(right.updatedAt),
      isActiveTask(right) ? taskTimestampMs(right.execution?.lastActivityAt) : 0,
    );
    const timeDelta = rightAt - leftAt;
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function partitionTasks(tasks: readonly TaskSummary[]): {
  active: TaskSummary[];
  recent: TaskSummary[];
} {
  const byId = (left: TaskSummary, right: TaskSummary) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return {
    // Creation is immutable, so progress and queued-to-running transitions cannot move active rows.
    active: tasks
      .filter((task) => task.status === "queued" || task.status === "running")
      .toSorted(
        (left, right) =>
          taskTimestampMs(left.createdAt) - taskTimestampMs(right.createdAt) || byId(left, right),
      ),
    recent: tasks
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .toSorted(
        (left, right) =>
          taskTimestampMs(right.endedAt ?? right.updatedAt ?? right.createdAt) -
            taskTimestampMs(left.endedAt ?? left.updatedAt ?? left.createdAt) || byId(left, right),
      )
      .slice(0, 50),
  };
}

export function normalizeTasksListResult(
  value: unknown,
): { tasks: TaskSummary[]; nextCursor?: string } | null {
  if (!Value.Check(TasksListResultSchema, value)) {
    return null;
  }
  return {
    tasks: sortTasks(
      value.tasks.map(normalizeTaskSummary).filter((task): task is TaskSummary => task !== null),
    ),
    ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor } : {}),
  };
}

export function normalizeTasksGetResult(value: unknown): TaskSummary | null {
  if (!Value.Check(TasksGetResultSchema, value)) {
    return null;
  }
  return normalizeTaskSummary(value.task);
}

// The ledger pages newest-first, so one page can hide long-running tasks behind
// newer terminal records; callers fetch active tasks separately and merge here.
export function mergeTaskLists(...lists: readonly (readonly TaskSummary[])[]): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  for (const list of lists) {
    for (const task of list) {
      const current = byId.get(task.id);
      byId.set(task.id, current ? newestTaskSnapshot(current, task, "snapshot") : task);
    }
  }
  return sortTasks([...byId.values()]);
}

// Cancellation refusals (already-terminal, missing handle, stale id) arrive as
// successful responses with cancelled=false + reason, not thrown errors.
type NormalizedTasksCancelResult = Omit<TasksCancelResult, "task"> & { task?: TaskSummary };

export function normalizeTasksCancelResult(value: unknown): NormalizedTasksCancelResult | null {
  if (!Value.Check(TasksCancelResultSchema, value)) {
    return null;
  }
  const reason = optionalString(value.reason);
  const task = normalizeTaskSummary(value.task);
  return {
    found: value.found,
    cancelled: value.cancelled,
    ...(reason ? { reason } : {}),
    ...(task ? { task } : {}),
  };
}

export function normalizeTaskEventPayload(value: unknown): TaskEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.action === "restored") {
    return { action: "restored" };
  }
  if (value.action === "deleted") {
    const taskId = optionalString(value.taskId);
    return taskId ? { action: "deleted", taskId } : null;
  }
  if (value.action === "upserted") {
    const task = normalizeTaskSummary(value.task);
    return task ? { action: "upserted", task } : null;
  }
  return null;
}

/** Task events omit detail-only prompts; repeated snapshots share the event freshness rules. */
export function coalesceTaskEvent(
  pending: Map<string, CoalescedTaskEvent>,
  event: Exclude<TaskEventPayload, { action: "restored" }>,
): void {
  if (event.action === "deleted") {
    pending.set(event.taskId, { action: "deleted" });
    return;
  }
  const previous = pending.get(event.task.id);
  pending.set(event.task.id, {
    action: "upserted",
    task:
      previous?.action === "upserted"
        ? newestTaskSnapshot(previous.task, event.task, "event")
        : event.task,
    afterDelete:
      previous?.action === "deleted" || (previous?.action === "upserted" && previous.afterDelete),
  });
}

export function replayTaskEvents(
  tasks: readonly TaskSummary[],
  pending: ReadonlyMap<string, CoalescedTaskEvent>,
): TaskSummary[] {
  let result = [...tasks];
  for (const [taskId, event] of pending) {
    // A recreated task must replace even a newer row from the pre-delete snapshot.
    if (event.action === "deleted" || event.afterDelete) {
      result = sortTasks(result.filter((task) => task.id !== taskId));
    }
    if (event.action === "upserted") {
      const current = result.find((task) => task.id === event.task.id);
      const next = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
      result = sortTasks([next, ...result.filter((task) => task.id !== event.task.id)]);
    }
  }
  return result;
}
