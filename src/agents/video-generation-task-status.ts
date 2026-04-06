import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  getMediaGenerationTaskProviderId,
  isActiveMediaGenerationTask,
} from "./media-generation-task-status-shared.js";

export const VIDEO_GENERATION_TASK_KIND = "video_generation";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";

export function isActiveVideoGenerationTask(task: TaskRecord): boolean {
  return isActiveMediaGenerationTask({
    task,
    taskKind: VIDEO_GENERATION_TASK_KIND,
  });
}

export function getVideoGenerationTaskProviderId(task: TaskRecord): string | undefined {
  return getMediaGenerationTaskProviderId(task, VIDEO_GENERATION_SOURCE_PREFIX);
}

export function findActiveVideoGenerationTaskForSession(sessionKey?: string): TaskRecord | null {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    taskKind: VIDEO_GENERATION_TASK_KIND,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
  });
}

export function buildVideoGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    task,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
  });
}

export function buildVideoGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    task,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    nounLabel: "Video generation",
    toolName: "video_generate",
    completionLabel: "video",
    duplicateGuard: params?.duplicateGuard,
  });
}

export function buildActiveVideoGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    sessionKey,
    taskKind: VIDEO_GENERATION_TASK_KIND,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    nounLabel: "Video generation",
    toolName: "video_generate",
    completionLabel: "videos",
  });
}
