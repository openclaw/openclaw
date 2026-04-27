import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import { createMediaGenerationTaskLifecycle, } from "./media-generate-background-shared.js";
const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
    toolName: "video_generate",
    taskKind: VIDEO_GENERATION_TASK_KIND,
    label: "Video generation",
    queuedProgressSummary: "Queued video generation",
    generatedLabel: "video",
    failureProgressSummary: "Video generation failed",
    eventSource: "video_generation",
    announceType: "video generation task",
    completionLabel: "video",
});
export const createVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.createTaskRun(...params);
export const recordVideoGenerationTaskProgress = (...params) => videoGenerationTaskLifecycle.recordTaskProgress(...params);
export const completeVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.completeTaskRun(...params);
export const failVideoGenerationTaskRun = (...params) => videoGenerationTaskLifecycle.failTaskRun(...params);
export async function wakeVideoGenerationTaskCompletion(params) {
    await videoGenerationTaskLifecycle.wakeTaskCompletion(params);
}
