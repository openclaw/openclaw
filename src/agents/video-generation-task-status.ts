import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

const ACTIVE_VIDEO_GENERATION_STATUSES = new Set(["queued", "running"]);
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";

function isActiveStatus(status: string): boolean {
  return ACTIVE_VIDEO_GENERATION_STATUSES.has(status);
}

export function isActiveVideoGenerationTask(task: TaskRecord): boolean {
  const sourceId = task.sourceId?.trim() ?? "";
  return (
    task.runtime === "cli" &&
    task.scopeKind === "session" &&
    isActiveStatus(task.status) &&
    (sourceId === VIDEO_GENERATION_SOURCE_PREFIX ||
      sourceId.startsWith(`${VIDEO_GENERATION_SOURCE_PREFIX}:`))
  );
}

export function getVideoGenerationTaskProviderId(task: TaskRecord): string | undefined {
  const sourceId = task.sourceId?.trim() ?? "";
  if (!sourceId.startsWith(`${VIDEO_GENERATION_SOURCE_PREFIX}:`)) {
    return undefined;
  }
  const providerId = sourceId.slice(`${VIDEO_GENERATION_SOURCE_PREFIX}:`.length).trim();
  return providerId || undefined;
}

export function findActiveVideoGenerationTaskForSession(sessionKey?: string): TaskRecord | null {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return null;
  }
  const activeTasks = listTasksForOwnerKey(normalizedSessionKey).filter(
    isActiveVideoGenerationTask,
  );
  if (activeTasks.length === 0) {
    return null;
  }
  return activeTasks.find((task) => task.status === "running") ?? activeTasks[0] ?? null;
}

export function buildVideoGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  const provider = getVideoGenerationTaskProviderId(task);
  return {
    async: true,
    active: true,
    existingTask: true,
    status: task.status,
    task: {
      taskId: task.taskId,
      ...(task.runId ? { runId: task.runId } : {}),
    },
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    ...(provider ? { provider } : {}),
  };
}

export function buildVideoGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  const provider = getVideoGenerationTaskProviderId(task);
  const lines = [
    `Video generation task ${task.taskId} is already ${task.status}${provider ? ` with ${provider}` : ""}.`,
    task.progressSummary ? `Progress: ${task.progressSummary}.` : null,
    params?.duplicateGuard
      ? "Do not call video_generate again for this request. Wait for the completion event; I will post the finished video here."
      : "Wait for the completion event; I will post the finished video here when it's ready.",
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}

export function buildActiveVideoGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  const task = findActiveVideoGenerationTaskForSession(sessionKey);
  if (!task) {
    return undefined;
  }
  const provider = getVideoGenerationTaskProviderId(task);
  const lines = [
    "An active video generation background task already exists for this session.",
    `Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
    task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
    "Do not call `video_generate` again for the same request while that task is queued or running.",
    'If the user asks for progress or whether the work is async, explain the active task state or call `video_generate` with `action:"status"` instead of starting a new generation.',
    "Only start a new `video_generate` call if the user clearly asks for a different/new video.",
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}
