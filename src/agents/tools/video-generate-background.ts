import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/task-executor.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/video-generate-background");

export type VideoGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

export function createVideoGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
}): VideoGenerationTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:video_generate:${crypto.randomUUID()}`;
  try {
    const task = createRunningTaskRun({
      runtime: "cli",
      sourceId: params.providerId ? `video_generate:${params.providerId}` : "video_generate",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin: params.requesterOrigin,
      childSessionKey: sessionKey,
      runId,
      label: "Video generation",
      task: params.prompt,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Queued video generation",
    });
    return {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin: params.requesterOrigin,
      taskLabel: params.prompt,
    };
  } catch (error) {
    log.warn("Failed to create video generation task ledger record", {
      sessionKey,
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

export function recordVideoGenerationTaskProgress(params: {
  handle: VideoGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  recordTaskRunProgressByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function completeVideoGenerationTaskRun(params: {
  handle: VideoGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
}) {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const target = params.count === 1 ? params.paths[0] : `${params.count} files`;
  completeTaskRunByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    endedAt,
    lastEventAt: endedAt,
    progressSummary: `Generated ${params.count} video${params.count === 1 ? "" : "s"}`,
    terminalSummary: `Generated ${params.count} video${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`,
  });
}

export function failVideoGenerationTaskRun(params: {
  handle: VideoGenerationTaskHandle | null;
  error: unknown;
}) {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const errorText = params.error instanceof Error ? params.error.message : String(params.error);
  failTaskRunByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    endedAt,
    lastEventAt: endedAt,
    error: errorText,
    progressSummary: "Video generation failed",
    terminalSummary: errorText,
  });
}

function buildVideoGenerationReplyInstruction(status: "ok" | "error"): string {
  if (status === "ok") {
    return [
      "A completed video generation task is ready for user delivery.",
      "Reply in your normal assistant voice and post the finished video to the original message channel now.",
      "If the result includes MEDIA: lines, include those exact MEDIA: lines in your reply so OpenClaw attaches the video.",
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    "A video generation task failed.",
    "Reply in your normal assistant voice with the failure summary now.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

export async function wakeVideoGenerationTaskCompletion(params: {
  handle: VideoGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  statsLine?: string;
}) {
  if (!params.handle) {
    return;
  }
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: "video_generation",
      childSessionKey: `video_generate:${params.handle.taskId}`,
      childSessionId: params.handle.taskId,
      announceType: "video generation task",
      taskLabel: params.handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: params.result,
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildVideoGenerationReplyInstruction(params.status),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    "A video generation task finished. Process the completion update now.";
  const announceId = `video-generate:${params.handle.taskId}:${params.status}`;
  const delivery = await deliverSubagentAnnouncement({
    requesterSessionKey: params.handle.requesterSessionKey,
    targetRequesterSessionKey: params.handle.requesterSessionKey,
    announceId,
    triggerMessage,
    steerMessage: triggerMessage,
    internalEvents,
    summaryLine: params.handle.taskLabel,
    requesterSessionOrigin: params.handle.requesterOrigin,
    requesterOrigin: params.handle.requesterOrigin,
    completionDirectOrigin: params.handle.requesterOrigin,
    directOrigin: params.handle.requesterOrigin,
    sourceSessionKey: `video_generate:${params.handle.taskId}`,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceTool: "video_generate",
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (!delivery.delivered && delivery.error) {
    log.warn("Video generation completion wake failed", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      error: delivery.error,
    });
  }
}
