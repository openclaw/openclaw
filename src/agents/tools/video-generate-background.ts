import type { OpenClawConfig } from "../../config/config.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  completeMediaGenerationTaskRun,
  createMediaGenerationTaskRun,
  failMediaGenerationTaskRun,
  recordMediaGenerationTaskProgress,
  wakeMediaGenerationTaskCompletion,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

export function createVideoGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
}): VideoGenerationTaskHandle | null {
  return createMediaGenerationTaskRun({
    sessionKey: params.sessionKey,
    requesterOrigin: params.requesterOrigin,
    prompt: params.prompt,
    providerId: params.providerId,
    toolName: "video_generate",
    taskKind: VIDEO_GENERATION_TASK_KIND,
    label: "Video generation",
    queuedProgressSummary: "Queued video generation",
  });
}

export function recordVideoGenerationTaskProgress(params: {
  handle: VideoGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  recordMediaGenerationTaskProgress(params);
}

export function completeVideoGenerationTaskRun(params: {
  handle: VideoGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
}) {
  completeMediaGenerationTaskRun({
    ...params,
    generatedLabel: "video",
  });
}

export function failVideoGenerationTaskRun(params: {
  handle: VideoGenerationTaskHandle | null;
  error: unknown;
}) {
  failMediaGenerationTaskRun({
    ...params,
    progressSummary: "Video generation failed",
  });
}

export async function wakeVideoGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: VideoGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await wakeMediaGenerationTaskCompletion({
    config: params.config,
    handle: params.handle,
    status: params.status,
    statusLabel: params.statusLabel,
    result: params.result,
    mediaUrls: params.mediaUrls,
    statsLine: params.statsLine,
    eventSource: "video_generation",
    announceType: "video generation task",
    toolName: "video_generate",
    completionLabel: "video",
  });
}
