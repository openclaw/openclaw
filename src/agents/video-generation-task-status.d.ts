import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare const VIDEO_GENERATION_TASK_KIND = "video_generation";
export declare function isActiveVideoGenerationTask(task: TaskRecord): boolean;
export declare function getVideoGenerationTaskProviderId(task: TaskRecord): string | undefined;
export declare function findActiveVideoGenerationTaskForSession(sessionKey?: string): TaskRecord | undefined;
export declare function buildVideoGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown>;
export declare function buildVideoGenerationTaskStatusText(task: TaskRecord, params?: {
    duplicateGuard?: boolean;
}): string;
export declare function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey?: string): string | undefined;
