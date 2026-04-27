import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import { createMediaGenerationTaskLifecycle, } from "./media-generate-background-shared.js";
const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
    toolName: "music_generate",
    taskKind: MUSIC_GENERATION_TASK_KIND,
    label: "Music generation",
    queuedProgressSummary: "Queued music generation",
    generatedLabel: "track",
    failureProgressSummary: "Music generation failed",
    eventSource: "music_generation",
    announceType: "music generation task",
    completionLabel: "music",
});
export const createMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.createTaskRun(...params);
export const recordMusicGenerationTaskProgress = (...params) => musicGenerationTaskLifecycle.recordTaskProgress(...params);
export const completeMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.completeTaskRun(...params);
export const failMusicGenerationTaskRun = (...params) => musicGenerationTaskLifecycle.failTaskRun(...params);
export async function wakeMusicGenerationTaskCompletion(params) {
    await musicGenerationTaskLifecycle.wakeTaskCompletion(params);
}
