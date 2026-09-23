/**
 * Shared detached-task lifecycle for media generation tools.
 *
 * Image, video, and music generation use this to track tasks, wake sessions, and deliver generated media.
 */
import crypto from "node:crypto";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  observeSessionDeliveryRuntime,
  type SessionDeliveryObservation,
} from "../../infra/session-delivery-queue-runtime.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import {
  runInDetachedAsyncContext,
  runOutsideAsyncWorkScope,
} from "../../shared/async-work-scope.js";
import { removeCronRunContinuationSessionIfIdle } from "../../tasks/cron-run-continuation-cleanup.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  clearGeneratedMediaTaskActivity,
  registerGeneratedMediaTaskActivity,
} from "../../tasks/generated-media-task-activity.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  type RequiredCompletionTerminalResult,
} from "../../tasks/task-completion-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import type { AgentInternalEvent } from "../internal-events.js";
import {
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
  MEDIA_GENERATION_QUEUED_COMPLETION_PROGRESS,
} from "../media-generation-task-status-shared.js";
import { loadRequesterSessionEntry } from "../subagents/announce/subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "../subagents/announce/subagent-announce-origin.js";
import {
  type MediaGenerationCompletionWakeOutcome,
  type MediaGenerationTaskHandle,
  retainBlockedMediaReferences,
  wakeMediaGenerationTaskCompletion,
} from "./media-generate-background-completion.js";
export type { MediaGenerationTaskHandle } from "./media-generate-background-completion.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 60_000;
const MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const MEDIA_GENERATION_COMPLETION_HANDOFF_TIMEOUT_MS = 120_000;

/** Schedules detached media generation work. */
export type MediaGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

/** Optional callback invoked when async media generation starts. */
export type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;

/** Returns whether a media generation request should detach for a session. */
export function shouldDetachMediaGenerationTask(
  sessionKey: string | undefined,
  requesterAgentId?: string,
): boolean {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return false;
  }
  if (!parseCronRunScopeSuffix(normalizedSessionKey).runId) {
    return true;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      sessionKey: normalizedSessionKey,
      agentId: requesterAgentId,
      clone: false,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    const marker = entry?.cronRunContinuation;
    if (!marker) {
      // Exact cron work without a durable checkpoint cannot be resumed safely.
      return false;
    }
    const cliExecutionProvider = marker.cliExecutionProvider?.trim();
    return (
      !cliExecutionProvider || Boolean(getCliSessionBinding(entry, cliExecutionProvider)?.sessionId)
    );
  } catch {
    // Exact cron work without a readable continuation row cannot be resumed.
    return false;
  }
}

/** Successful media generation output used to complete and wake detached tasks. */
export type MediaGenerationExecutionResult = {
  provider: string;
  model: string;
  count: number;
  wakeResult: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
};

type CreateMediaGenerationTaskRunParams = {
  sessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
};

type RecordMediaGenerationTaskProgressParams = {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
};

type CompleteMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  terminalResult?: RequiredCompletionTerminalResult;
};

type FailMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
};

type WakeMediaGenerationTaskCompletionParams = {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
};

type MediaGenerationTaskLifecycle = {
  createTaskRun: (params: CreateMediaGenerationTaskRunParams) => MediaGenerationTaskHandle | null;
  recordTaskProgress: (params: RecordMediaGenerationTaskProgressParams) => void;
  completeTaskRun: (params: CompleteMediaGenerationTaskRunParams) => void;
  failTaskRun: (params: FailMediaGenerationTaskRunParams) => void;
  wakeTaskCompletion: (
    params: WakeMediaGenerationTaskCompletionParams,
  ) => Promise<MediaGenerationCompletionWakeOutcome>;
};

function waitForMediaGenerationCompletionHandoffRetry(
  delayMs: number,
  signal?: AbortSignal,
  keepAlive = false,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (!keepAlive) {
      timer.unref?.();
    }
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

async function wakeMediaGenerationTaskCompletionWithRetry(params: {
  wake: () => Promise<MediaGenerationCompletionWakeOutcome>;
  beforeRetry?: (outcome: MediaGenerationCompletionWakeOutcome) => void;
  observation?: SessionDeliveryObservation;
}): Promise<MediaGenerationCompletionWakeOutcome> {
  const runtimeSignal = params.observation?.signal;
  let queueAccepted = false;
  let progressStatus: MediaGenerationCompletionWakeOutcome["status"] | undefined;
  let progressRecordedAt = 0;
  try {
    const deadline = Date.now() + MEDIA_GENERATION_COMPLETION_HANDOFF_TIMEOUT_MS;
    let outcome = await params.wake();
    let retryIndex = 0;
    while (outcome.status === "pending" || outcome.status === "session_queued") {
      queueAccepted ||= outcome.status === "session_queued";
      const now = Date.now();
      if (
        outcome.status === "session_queued" &&
        (progressStatus !== outcome.status ||
          now - progressRecordedAt >= MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS)
      ) {
        // Record custody even when the first admission overlaps shutdown. Receipt
        // polling must not turn into a task-ledger write on every observation.
        params.beforeRetry?.(outcome);
        progressStatus = outcome.status;
        progressRecordedAt = now;
      }
      runtimeSignal?.throwIfAborted();
      if (outcome.status === "session_queued" && !runtimeSignal) {
        return outcome;
      }
      // Accepted queue work owns its own delivery deadline and terminal result.
      // The short producer budget only bounds an unconfirmed cron handoff.
      const remainingMs =
        outcome.status === "session_queued" ? Number.POSITIVE_INFINITY : deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("cron continuation did not become ready before the handoff deadline");
      }
      if (outcome.status === "pending") {
        // Unconfirmed cron handoffs retain their existing per-attempt progress.
        params.beforeRetry?.(outcome);
        progressStatus = outcome.status;
      }
      // Reuse the idempotent handoff to observe settlement without creating a new send.
      const delayMs =
        MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS[
          Math.min(retryIndex, MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS.length - 1)
        ] ?? 2_000;
      await waitForMediaGenerationCompletionHandoffRetry(
        Math.min(delayMs, remainingMs),
        runtimeSignal,
      );
      runtimeSignal?.throwIfAborted();
      outcome = await params.wake();
      retryIndex += 1;
    }
    return outcome;
  } catch (error) {
    // Shutdown only leaves recoverable work after the queue confirmed custody.
    // An unaccepted handoff failure must still settle the original media task.
    if (runtimeSignal?.aborted && queueAccepted) {
      let retryIndex = 0;
      while (params.observation?.canReconcileAfterDrain()) {
        try {
          // The owner has joined its active deliveries. Read the existing
          // idempotent outcome before releasing task terminalization.
          return await params.wake();
        } catch (readError) {
          const delayMs = MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS[retryIndex++];
          if (delayMs === undefined) {
            // Preserve the existing unconfirmed-completion error contract instead
            // of leaving a running task whose delivery may already have settled.
            throw readError;
          }
          // Runtime retirement joins these bounded retries before disposing its
          // database. Unlike a parked observer, this final read must keep Node alive.
          await waitForMediaGenerationCompletionHandoffRetry(delayMs, undefined, true);
        }
      }
      return { status: "session_queued" };
    }
    throw error;
  }
}

function touchMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle) {
  registerGeneratedMediaTaskActivity(handle.runId, handle.requesterSessionKey);
  registerAgentRunContext(handle.runId, {
    sessionKey: handle.requesterSessionKey,
    agentId: handle.requesterAgentId,
    lastActiveAt: Date.now(),
  });
}

function createMediaGenerationTaskRun(params: {
  sessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
}): MediaGenerationTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  try {
    // Pin the complete requester route when detached work starts. Completion-time
    // session state can move to another peer while generation is still running.
    const requesterOrigin = resolveAnnounceOrigin(
      loadRequesterSessionEntry(sessionKey, params.requesterAgentId).entry,
      params.requesterOrigin,
    );
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      requesterSessionKey: sessionKey,
      requesterAgentId: params.requesterAgentId,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin,
      childSessionKey: sessionKey,
      runId,
      label: params.label,
      task: params.prompt,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: params.queuedProgressSummary,
    });
    if (!task) {
      return null;
    }
    const handle = {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterAgentId: params.requesterAgentId,
      requesterOrigin,
      taskLabel: params.prompt,
    };
    touchMediaGenerationTaskRunContext(handle);
    return handle;
  } catch (error) {
    log.warn("Failed to create media generation task ledger record", {
      sessionKey,
      toolName: params.toolName,
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

function recordMediaGenerationTaskProgress(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  touchMediaGenerationTaskRunContext(params.handle);
  recordTaskRunProgressByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

function clearMediaGenerationTaskRunContext(
  handle: MediaGenerationTaskHandle,
  settled = true,
): void {
  clearGeneratedMediaTaskActivity(handle.runId);
  clearAgentRunContext(handle.runId);
  if (!settled) {
    // Runtime shutdown releases only process-local observation, not durable continuation state.
    return;
  }
  // A one-shot cron job can be deleted before detached media settles, leaving no
  // later timer tick to reap its exact continuation row.
  void removeCronRunContinuationSessionIfIdle(handle.requesterSessionKey).catch(
    (error: unknown) => {
      log.warn("Failed to remove settled cron media continuation", {
        taskId: handle.taskId,
        runId: handle.runId,
        error: formatErrorMessage(error),
      });
    },
  );
}

/** Periodically refreshes task progress while a media generation operation runs. */
async function withMediaGenerationTaskKeepalive<T>(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (!params.handle) {
    return await params.run();
  }
  const interval = setInterval(() => {
    recordMediaGenerationTaskProgress({
      handle: params.handle,
      progressSummary: params.progressSummary,
      eventSummary: params.eventSummary,
    });
  }, MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS);
  interval.unref?.();
  try {
    return await params.run();
  } finally {
    clearInterval(interval);
  }
}

function completeMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  generatedLabel: string;
  terminalResult?: RequiredCompletionTerminalResult;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    completeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"}`,
      terminalSummary:
        params.terminalResult?.terminalSummary ??
        `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}.`,
      terminalOutcome: params.terminalResult?.terminalOutcome,
    });
  } finally {
    clearMediaGenerationTaskRunContext(params.handle);
  }
}

function failMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  progressSummary: string;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const errorText = formatErrorMessage(params.error);
    failTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: errorText,
      progressSummary: params.progressSummary,
      terminalSummary: errorText,
    });
  } finally {
    clearMediaGenerationTaskRunContext(params.handle);
  }
}

/** Creates the default microtask scheduler for detached media generation jobs. */
export function createDefaultMediaGenerateBackgroundScheduler(params: {
  toolName: string;
  onCrash: (message: string, meta?: Record<string, unknown>) => void;
}): MediaGenerateBackgroundScheduler {
  return (work) => {
    runInDetachedAsyncContext(() => {
      runOutsideAsyncWorkScope(() => {
        queueMicrotask(() => {
          void work().catch((error: unknown) => {
            params.onCrash(`Detached ${params.toolName} job crashed`, { error });
          });
        });
      });
    });
  };
}

/** Builds the immediate tool result returned after a background media task starts. */
export function buildMediaGenerationStartedToolResult(params: {
  toolName: string;
  generationLabel: string;
  completionLabel: string;
  taskHandle: MediaGenerationTaskHandle | null;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
          ...(params.messages ?? []),
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n"),
      },
    ],
    details: {
      async: true,
      status: "started",
      ...(params.taskHandle
        ? {
            taskId: params.taskHandle.taskId,
            runId: params.taskHandle.runId,
            task: {
              taskId: params.taskHandle.taskId,
              runId: params.taskHandle.runId,
            },
          }
        : {}),
      ...params.detailExtras,
    },
  };
}

/** Notifies an optional async-start observer and logs callback failures. */
export async function notifyMediaGenerationAsyncTaskStarted(params: {
  callback?: MediaGenerateAsyncStartCallback;
  message: string;
  toolName: string;
  handle: MediaGenerationTaskHandle | null;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  if (!params.callback) {
    return;
  }
  try {
    await params.callback(params.message);
  } catch (error) {
    params.onFailure("Media generation async-start callback failed", {
      toolName: params.toolName,
      taskId: params.handle?.taskId,
      runId: params.handle?.runId,
      error,
    });
  }
}

/** Schedules media generation work and wires result/failure handling into task lifecycle. */
export function scheduleMediaGenerationTaskCompletion<
  T extends MediaGenerationExecutionResult,
>(params: {
  lifecycle: MediaGenerationTaskLifecycle;
  handle: MediaGenerationTaskHandle | null;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  progressSummary: string;
  config?: OpenClawConfig;
  toolName: string;
  run: () => Promise<T>;
  onWakeFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const runBackgroundWork = async () => {
    const recordCompletionDeliveryProgress = (outcome?: MediaGenerationCompletionWakeOutcome) => {
      try {
        params.lifecycle.recordTaskProgress({
          handle: params.handle,
          progressSummary:
            outcome?.status === "session_queued"
              ? MEDIA_GENERATION_QUEUED_COMPLETION_PROGRESS
              : MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
        });
      } catch (error) {
        params.onWakeFailure(`${params.toolName} completion progress update failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error,
        });
      }
    };
    let executed: T;
    try {
      executed = await withMediaGenerationTaskKeepalive({
        handle: params.handle,
        progressSummary: params.progressSummary,
        run: params.run,
      });
    } catch (error) {
      return await observeSessionDeliveryRuntime(async (observation) => {
        try {
          const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
            observation,
            wake: async () =>
              await params.lifecycle.wakeTaskCompletion({
                config: params.config,
                handle: params.handle,
                status: "error",
                statusLabel: "failed",
                result: formatErrorMessage(error),
              }),
            beforeRetry: (outcome) => {
              if (outcome.status === "session_queued") {
                recordCompletionDeliveryProgress(outcome);
              }
            },
          });
          if (wakeOutcome.status === "session_queued" || wakeOutcome.status === "pending") {
            if (params.handle) {
              clearMediaGenerationTaskRunContext(params.handle, false);
            }
            return;
          }
          if (wakeOutcome.status !== "delivered") {
            params.onWakeFailure(
              `${params.toolName} failure completion delivery was not confirmed`,
              {
                taskId: params.handle?.taskId,
                runId: params.handle?.runId,
              },
            );
          }
        } catch (wakeError) {
          params.onWakeFailure(`${params.toolName} failure wake failed`, {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
            error: wakeError,
          });
        }
        params.lifecycle.failTaskRun({ handle: params.handle, error });
      });
    }

    return await observeSessionDeliveryRuntime(async (observation) => {
      recordCompletionDeliveryProgress();
      let terminalResult: RequiredCompletionTerminalResult | undefined;
      try {
        const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
          observation,
          wake: async () =>
            await params.lifecycle.wakeTaskCompletion({
              config: params.config,
              handle: params.handle,
              status: "ok",
              statusLabel: "completed successfully",
              result: executed.wakeResult,
              attachments: executed.attachments,
              mediaUrls: executed.mediaUrls,
            }),
          // Keep task activity fresh while the existing handoff owner is settling.
          beforeRetry: recordCompletionDeliveryProgress,
        });
        if (wakeOutcome.status === "session_queued" || wakeOutcome.status === "pending") {
          // The stopped runtime no longer owns observation. Its durable row remains
          // recoverable; do not turn local observer cancellation into delivery failure.
          if (params.handle) {
            clearMediaGenerationTaskRunContext(params.handle, false);
          }
          return;
        }
        if (wakeOutcome.status !== "delivered") {
          const failureReason = "completion delivery was not confirmed after successful generation";
          terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(failureReason);
          params.onWakeFailure(`${params.toolName} ${failureReason}`, {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
          });
        }
      } catch (error) {
        terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(
          formatErrorMessage(error),
        );
        params.onWakeFailure(
          `${params.toolName} completion wake failed after successful generation`,
          {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
            error,
          },
        );
      }
      terminalResult = retainBlockedMediaReferences(terminalResult, executed.attachments);
      try {
        params.lifecycle.completeTaskRun({
          handle: params.handle,
          provider: executed.provider,
          model: executed.model,
          count: executed.count,
          terminalResult,
        });
      } catch (error) {
        params.onWakeFailure(`${params.toolName} completion state update failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error,
        });
        params.lifecycle.failTaskRun({
          handle: params.handle,
          error,
        });
      }
    });
  };
  // Detached completion needs its own transcript lock after the parent attempt exits.
  params.scheduleBackgroundWork(() => runWithoutOwnedSessionTranscriptWrites(runBackgroundWork));
}

/** Creates a tool-specific detached media generation lifecycle facade. */
export function createMediaGenerationTaskLifecycle(params: {
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
  generatedLabel: string;
  failureProgressSummary: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  completionLabel: string;
}): MediaGenerationTaskLifecycle {
  return {
    createTaskRun(runParams: CreateMediaGenerationTaskRunParams): MediaGenerationTaskHandle | null {
      return createMediaGenerationTaskRun({
        ...runParams,
        toolName: params.toolName,
        taskKind: params.taskKind,
        label: params.label,
        queuedProgressSummary: params.queuedProgressSummary,
      });
    },

    recordTaskProgress(progressParams: RecordMediaGenerationTaskProgressParams) {
      recordMediaGenerationTaskProgress(progressParams);
    },

    completeTaskRun(completionParams: CompleteMediaGenerationTaskRunParams) {
      completeMediaGenerationTaskRun({
        ...completionParams,
        generatedLabel: params.generatedLabel,
      });
    },

    failTaskRun(failureParams: FailMediaGenerationTaskRunParams) {
      failMediaGenerationTaskRun({
        ...failureParams,
        progressSummary: params.failureProgressSummary,
      });
    },

    async wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams) {
      return await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        eventSource: params.eventSource,
        announceType: params.announceType,
        toolName: params.toolName,
        completionLabel: params.completionLabel,
      });
    },
  };
}
