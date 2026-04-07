import type { OpenClawConfig } from "../../config/config.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  completeMediaGenerationTaskRun,
  createMediaGenerationTaskRun,
  failMediaGenerationTaskRun,
  recordMediaGenerationTaskProgress,
  wakeMediaGenerationTaskCompletion,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;

export function createMusicGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
}): MusicGenerationTaskHandle | null {
  return createMediaGenerationTaskRun({
    sessionKey: params.sessionKey,
    requesterOrigin: params.requesterOrigin,
    prompt: params.prompt,
    providerId: params.providerId,
    toolName: "music_generate",
    taskKind: MUSIC_GENERATION_TASK_KIND,
    label: "Music generation",
    queuedProgressSummary: "Queued music generation",
  });
}

export function recordMusicGenerationTaskProgress(params: {
  handle: MusicGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  recordMediaGenerationTaskProgress(params);
}

export function completeMusicGenerationTaskRun(params: {
  handle: MusicGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
}) {
  completeMediaGenerationTaskRun({
    ...params,
    generatedLabel: "track",
  });
}

export function failMusicGenerationTaskRun(params: {
  handle: MusicGenerationTaskHandle | null;
  error: unknown;
}) {
  failMediaGenerationTaskRun({
    ...params,
    progressSummary: "Music generation failed",
  });
}

export async function wakeMusicGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MusicGenerationTaskHandle | null;
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
    eventSource: "music_generation",
    announceType: "music generation task",
    toolName: "music_generate",
    completionLabel: "music",
  });
}
