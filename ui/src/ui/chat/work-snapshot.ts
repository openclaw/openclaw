import type { SessionsListResult } from "../types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";

export type WorkSurfaceAction = "cancel_task" | "open_session" | "remove_queue" | "stop_run";

export type WorkSurfaceItemKind = "active_session" | "chat_run" | "queued_message" | "task";

export type WorkSurfaceItem = {
  id: string;
  kind: WorkSurfaceItemKind;
  title: string;
  status: string;
  detail?: string;
  updatedAt?: number;
  sessionKey?: string;
  projectId?: string;
  runId?: string;
  taskId?: string;
  actions: WorkSurfaceAction[];
};

export type WorkSurfaceTaskSummary = {
  id?: string;
  title?: string;
  status?: string;
  runtime?: string;
  kind?: string;
  sessionKey?: string;
  projectId?: string;
  runId?: string;
  taskId?: string;
  updatedAt?: number | string;
  createdAt?: number | string;
  progressSummary?: string;
  terminalSummary?: string;
  blockedReason?: string;
  error?: string;
};

export type BuildWorkSurfaceSnapshotInput = {
  assistantName?: string | null;
  chatRunId?: string | null;
  chatRunStatus?: ChatRunUiStatus | null;
  chatQueue?: ChatQueueItem[];
  currentSessionKey?: string | null;
  sessionsResult?: SessionsListResult | null;
  tasks?: WorkSurfaceTaskSummary[] | null;
};

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function queueTitle(item: ChatQueueItem): string {
  const text = normalizeText(item.text);
  if (text) {
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }
  const count = item.attachments?.length ?? 0;
  if (count > 0) {
    return count === 1 ? "Attached message" : `${count} attachments`;
  }
  return "Queued message";
}

function sessionTitle(row: NonNullable<SessionsListResult["sessions"]>[number]): string {
  return (
    normalizeText(row.displayName) ??
    normalizeText(row.derivedTitle) ??
    normalizeText(row.label) ??
    normalizeText(row.subject) ??
    row.key
  );
}

function taskStatusLabel(status: string | undefined): string {
  switch (status) {
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    default:
      return status ? status : "Working";
  }
}

function taskTitle(task: WorkSurfaceTaskSummary): string {
  return (
    normalizeText(task.title) ?? normalizeText(task.kind) ?? normalizeText(task.runtime) ?? "Task"
  );
}

function taskDetail(task: WorkSurfaceTaskSummary): string | undefined {
  return (
    normalizeText(task.progressSummary) ??
    normalizeText(task.blockedReason) ??
    normalizeText(task.error) ??
    normalizeText(task.terminalSummary) ??
    normalizeText(task.runtime)
  );
}

function itemRank(item: WorkSurfaceItem): number {
  if (item.kind === "chat_run") {
    return 0;
  }
  if (item.kind === "queued_message") {
    return 1;
  }
  if (item.kind === "task" && item.status.toLowerCase() === "running") {
    return 2;
  }
  if (item.kind === "task") {
    return 3;
  }
  return 4;
}

export function buildWorkSurfaceSnapshot(input: BuildWorkSurfaceSnapshotInput): WorkSurfaceItem[] {
  const items: WorkSurfaceItem[] = [];
  const currentSessionKey = normalizeText(input.currentSessionKey);
  const chatRunId = normalizeText(input.chatRunId);

  if (chatRunId) {
    const assistantName = normalizeText(input.assistantName) ?? "OpenClaw";
    items.push({
      id: `chat-run:${chatRunId}`,
      kind: "chat_run",
      title: `${assistantName} is working…`,
      status: "Working",
      updatedAt: input.chatRunStatus?.occurredAt,
      sessionKey: currentSessionKey,
      runId: chatRunId,
      actions: ["stop_run"],
    });
  }

  for (const item of input.chatQueue ?? []) {
    items.push({
      id: `queued:${item.id}`,
      kind: "queued_message",
      title: queueTitle(item),
      status: item.kind === "steered" ? "Steered" : "Queued",
      detail: item.localCommandName ? `/${item.localCommandName}` : undefined,
      updatedAt: item.createdAt,
      runId: item.pendingRunId,
      actions: ["remove_queue"],
    });
  }

  for (const task of input.tasks ?? []) {
    const taskId = normalizeText(task.taskId) ?? normalizeText(task.id);
    const status = taskStatusLabel(normalizeText(task.status));
    items.push({
      id: `task:${taskId ?? normalizeText(task.runId) ?? normalizeText(task.title) ?? items.length}`,
      kind: "task",
      title: taskTitle(task),
      status,
      detail: taskDetail(task),
      updatedAt: normalizeTimestamp(task.updatedAt) ?? normalizeTimestamp(task.createdAt),
      sessionKey: normalizeText(task.sessionKey),
      projectId: normalizeText(task.projectId),
      runId: normalizeText(task.runId),
      taskId,
      actions: taskId ? ["cancel_task"] : [],
    });
  }

  for (const row of input.sessionsResult?.sessions ?? []) {
    if (row.hasActiveRun !== true) {
      continue;
    }
    if (chatRunId && currentSessionKey && row.key === currentSessionKey) {
      continue;
    }
    items.push({
      id: `session:${row.key}`,
      kind: "active_session",
      title: sessionTitle(row),
      status: "Active",
      detail: row.lastMessagePreview ?? row.status ?? undefined,
      updatedAt: row.updatedAt ?? undefined,
      sessionKey: row.key,
      projectId: row.projectId,
      actions: ["open_session"],
    });
  }

  return items.toSorted((a, b) => {
    const rankDiff = itemRank(a) - itemRank(b);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

export function hasActiveWork(items: readonly WorkSurfaceItem[]): boolean {
  return items.length > 0;
}
