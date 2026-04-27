import { buildActiveMediaGenerationTaskPromptContextForSession, buildMediaGenerationTaskStatusDetails, buildMediaGenerationTaskStatusText, findActiveMediaGenerationTaskForSession, getMediaGenerationTaskProviderId, isActiveMediaGenerationTask, } from "./media-generation-task-status-shared.js";
export const VIDEO_GENERATION_TASK_KIND = "video_generation";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";
export function isActiveVideoGenerationTask(task) {
    return isActiveMediaGenerationTask({
        task,
        taskKind: VIDEO_GENERATION_TASK_KIND,
    });
}
export function getVideoGenerationTaskProviderId(task) {
    return getMediaGenerationTaskProviderId(task, VIDEO_GENERATION_SOURCE_PREFIX);
}
export function findActiveVideoGenerationTaskForSession(sessionKey) {
    return findActiveMediaGenerationTaskForSession({
        sessionKey,
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    });
}
export function buildVideoGenerationTaskStatusDetails(task) {
    return buildMediaGenerationTaskStatusDetails({
        task,
        sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    });
}
export function buildVideoGenerationTaskStatusText(task, params) {
    return buildMediaGenerationTaskStatusText({
        task,
        sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
        nounLabel: "Video generation",
        toolName: "video_generate",
        completionLabel: "video",
        duplicateGuard: params?.duplicateGuard,
    });
}
export function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey) {
    return buildActiveMediaGenerationTaskPromptContextForSession({
        sessionKey,
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
        nounLabel: "Video generation",
        toolName: "video_generate",
        completionLabel: "videos",
    });
}
