/**
 * Shared detached-task lifecycle for media generation tools.
 *
 * Image, video, and music generation use this to track tasks, wake sessions, and deliver generated media.
 */
import crypto from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  captureSessionTranscriptStorageEnvironment,
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptStorageEnvironment,
} from "../../config/sessions/transcript-target-binding.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { removeCronRunContinuationSessionIfIdle } from "../../cron/run-continuation-cleanup.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import {
  runInDetachedAsyncContext,
  runOutsideAsyncWorkScope,
} from "../../shared/async-work-scope.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  type RequiredCompletionTerminalResult,
} from "../completion-result.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import type { AgentInternalEvent } from "../internal-events.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  isMediaGenerationOperationCurrent,
  registerGeneratedMediaTaskActivity,
  updateMediaGenerationOperation,
} from "../media-generation-activity.js";
import { MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS } from "../media-generation-task-status-shared.js";
import { tryResolveSubagentRequesterAgentId } from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { resolveAnnounceOrigin } from "../subagents/announce/subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "../subagents/announce/subagent-requester-store-key.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import {
  retainBlockedMediaCompletion,
  retainBlockedMediaReferences,
  wakeMediaGenerationTaskCompletion,
  type MediaGenerationCompletionWakeOutcome,
  type MediaGenerationTaskHandle,
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
function shouldDetachMediaGenerationTask(
  sessionKey: string | undefined,
  entry?: SessionEntry,
): boolean {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return false;
  }
  if (!parseCronRunScopeSuffix(normalizedSessionKey).runId) {
    return true;
  }
  const marker = entry?.cronRunContinuation;
  if (!marker) {
    // Exact cron work without a durable checkpoint cannot be resumed safely.
    return false;
  }
  const cliExecutionProvider = marker.cliExecutionProvider?.trim();
  return (
    !cliExecutionProvider || Boolean(getCliSessionBinding(entry, cliExecutionProvider)?.sessionId)
  );
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
  assertCurrent?: () => void;
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
  createTaskRun: (
    params: CreateMediaGenerationTaskRunParams,
  ) => Promise<MediaGenerationTaskHandle | null>;
  recordTaskProgress: (params: RecordMediaGenerationTaskProgressParams) => void;
  completeTaskRun: (params: CompleteMediaGenerationTaskRunParams) => void;
  failTaskRun: (params: FailMediaGenerationTaskRunParams) => void;
  wakeTaskCompletion: (
    params: WakeMediaGenerationTaskCompletionParams,
  ) => Promise<MediaGenerationCompletionWakeOutcome>;
};

function waitForMediaGenerationCompletionHandoffRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function wakeMediaGenerationTaskCompletionWithRetry(params: {
  wake: () => Promise<MediaGenerationCompletionWakeOutcome>;
  beforeRetry?: () => void;
}): Promise<MediaGenerationCompletionWakeOutcome> {
  const deadline = Date.now() + MEDIA_GENERATION_COMPLETION_HANDOFF_TIMEOUT_MS;
  let outcome = await params.wake();
  let retryIndex = 0;
  while (outcome.status === "pending") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("media completion did not settle before the handoff deadline");
    }
    // Queue admission and an owned continuation can both be transient. Keep the
    // operation live until delivery, permanent refusal, or the bounded deadline.
    const delayMs =
      MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS[
        Math.min(retryIndex, MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS.length - 1)
      ] ?? 2_000;
    await waitForMediaGenerationCompletionHandoffRetry(Math.min(delayMs, remainingMs));
    params.beforeRetry?.();
    outcome = await params.wake();
    retryIndex += 1;
  }
  return outcome;
}

function touchMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle) {
  if (!isMediaGenerationOperationCurrent(handle.runId)) {
    return;
  }
  registerGeneratedMediaTaskActivity(
    handle.runId,
    handle.requesterSessionKey,
    handle.requesterAgentId,
  );
  registerAgentRunContext(handle.runId, {
    sessionKey: handle.requesterSessionKey,
    agentId: handle.requesterAgentId,
    lastActiveAt: Date.now(),
  });
}

/** Preserve all launch authority across both requester lookup and its caller's return await. */
export function captureMediaGenerationAdmission(assertSourceCurrent?: () => void): () => void {
  const generation = getAgentRunLifecycleGeneration();
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const assertInvocationCurrent = captureAgentToolSourceExecutionGuard();
  const assertGatewayCallerCurrent = captureGatewayToolCallerAssertion();
  const assertCurrent = () => {
    assertInvocationCurrent();
    assertGatewayCallerCurrent?.();
    assertSourceCurrent?.();
    if (
      generation !== getAgentRunLifecycleGeneration() ||
      !sameSessionTranscriptStorageEnvironment(
        env,
        captureSessionTranscriptStorageEnvironment(process.env),
      )
    ) {
      throw new Error("Media generation admission owner is no longer current");
    }
  };
  return assertCurrent;
}

async function createMediaGenerationTaskRun(
  params: CreateMediaGenerationTaskRunParams & {
    toolName: string;
    taskKind: string;
    label: string;
    queuedProgressSummary: string;
  },
): Promise<MediaGenerationTaskHandle | null> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  const assertCurrent = captureMediaGenerationAdmission(params.assertCurrent);
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  assertCurrent();
  try {
    // Pin the complete requester route when detached work starts. Completion-time
    // session state can move to another peer while generation is still running.
    const cfg = getRuntimeConfig();
    const agentId = tryResolveSubagentRequesterAgentId(cfg, sessionKey, params.requesterAgentId);
    const canonicalKey = resolveRequesterStoreKey(cfg, sessionKey, params.requesterAgentId);
    const storePath = agentId
      ? resolveSessionStorePathCore(cfg.session?.store, { agentId })
      : undefined;
    const entry =
      agentId && storePath
        ? await withSessionEntryReadOnlyInWorker(
            {
              agentId,
              storePath,
              env,
              sessionKey:
                sessionKey === "main" || sessionKey === normalizeMainKey(cfg.session?.mainKey)
                  ? canonicalKey
                  : sessionKey,
              hydrateSkillPromptRefs: false,
            },
            assertCurrent,
            async (read) => {
              if (!read.ok) {
                throw read.error;
              }
              return read.value;
            },
          )
        : undefined;
    assertCurrent();
    const requesterOrigin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    const requesterTranscript =
      entry?.sessionId && agentId && storePath
        ? {
            ...captureSessionTranscriptTargetBinding({
              agentId,
              env,
              sessionKey: canonicalKey,
              sessionId: entry.sessionId,
              storePath,
            }),
            lifecycleRevision: entry.lifecycleRevision ?? null,
          }
        : undefined;
    const task = createMediaGenerationOperation({
      taskId: runId,
      status: "running",
      createdAt: Date.now(),
      taskKind: params.taskKind,
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      requesterSessionKey: sessionKey,
      requesterAgentId: params.requesterAgentId,
      runId,
      task: params.prompt,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: params.queuedProgressSummary,
    });
    const handle = {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterAgentId: params.requesterAgentId,
      requesterOrigin,
      detach: Boolean(requesterTranscript) && shouldDetachMediaGenerationTask(sessionKey, entry),
      requesterTranscript,
      taskLabel: params.prompt,
    };
    touchMediaGenerationTaskRunContext(handle);
    return handle;
  } catch (error) {
    // A revoked invocation cannot become an untracked foreground provider call.
    assertCurrent();
    log.warn("Failed to admit media generation", {
      sessionKey,
      toolName: params.toolName,
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

function recordMediaGenerationTaskProgress(params: RecordMediaGenerationTaskProgressParams) {
  if (!params.handle) {
    return;
  }
  touchMediaGenerationTaskRunContext(params.handle);
  updateMediaGenerationOperation(params.handle.runId, {
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
  });
}

function clearMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle): void {
  const current = isMediaGenerationOperationCurrent(handle.runId);
  clearGeneratedMediaTaskActivity(handle.runId);
  clearAgentRunContext(handle.runId);
  if (!current) {
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

function completeMediaGenerationTaskRun(
  params: CompleteMediaGenerationTaskRunParams & {
    generatedLabel: string;
  },
) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    updateMediaGenerationOperation(params.handle.runId, {
      status: "succeeded",
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

function failMediaGenerationTaskRun(
  params: FailMediaGenerationTaskRunParams & {
    progressSummary: string;
  },
) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const errorText = formatErrorMessage(params.error);
    updateMediaGenerationOperation(params.handle.runId, {
      status: "failed",
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
    let executed: T;
    if (params.handle && !isMediaGenerationOperationCurrent(params.handle.runId)) {
      return;
    }
    try {
      executed = await withMediaGenerationTaskKeepalive({
        handle: params.handle,
        progressSummary: params.progressSummary,
        run: params.run,
      });
    } catch (error) {
      if (params.handle && !isMediaGenerationOperationCurrent(params.handle.runId)) {
        clearMediaGenerationTaskRunContext(params.handle);
        return;
      }
      try {
        const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
          wake: async () =>
            await params.lifecycle.wakeTaskCompletion({
              config: params.config,
              handle: params.handle,
              status: "error",
              statusLabel: "failed",
              result: formatErrorMessage(error),
            }),
        });
        if (wakeOutcome.status !== "delivered") {
          params.onWakeFailure(`${params.toolName} failure completion delivery was not confirmed`, {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
          });
        }
      } catch (wakeError) {
        params.onWakeFailure(`${params.toolName} failure wake failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error: wakeError,
        });
      }
      params.lifecycle.failTaskRun({ handle: params.handle, error });
      return;
    }

    if (params.handle && !isMediaGenerationOperationCurrent(params.handle.runId)) {
      clearMediaGenerationTaskRunContext(params.handle);
      return;
    }
    const recordCompletionDeliveryProgress = () => {
      try {
        params.lifecycle.recordTaskProgress({
          handle: params.handle,
          progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
        });
      } catch (error) {
        params.onWakeFailure(`${params.toolName} completion progress update failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error,
        });
      }
    };
    recordCompletionDeliveryProgress();
    let terminalResult: RequiredCompletionTerminalResult | undefined;
    try {
      const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
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
        // Keep the native operation and process-local activity fresh
        // while an exact cron continuation is still owned by its original run.
        beforeRetry: recordCompletionDeliveryProgress,
      });
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
      await retainBlockedMediaCompletion({
        handle: params.handle,
        terminalResult,
        attachments: executed.attachments,
        mediaUrls: executed.mediaUrls,
      });
    } catch (error) {
      params.onWakeFailure(`${params.toolName} blocked completion retention failed`, {
        taskId: params.handle?.taskId,
        runId: params.handle?.runId,
        error,
      });
    }
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
    createTaskRun(
      runParams: CreateMediaGenerationTaskRunParams,
    ): Promise<MediaGenerationTaskHandle | null> {
      return createMediaGenerationTaskRun({
        ...runParams,
        toolName: params.toolName,
        taskKind: params.taskKind,
        label: params.label,
        queuedProgressSummary: params.queuedProgressSummary,
      });
    },

    recordTaskProgress: recordMediaGenerationTaskProgress,

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
