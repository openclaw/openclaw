import crypto from "node:crypto";
import { computeBackoffSchedule, sleepWithAbort } from "@openclaw/retry";
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
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  isMediaGenerationOperationCurrent,
  registerGeneratedMediaTaskActivity,
  updateMediaGenerationOperation,
} from "../media-generation-activity.js";
import { MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS } from "../media-generation-task-status-shared.js";
import {
  IMAGE_GENERATION_TASK_KIND,
  MUSIC_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "../media-generation-task-status.js";
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

export type MediaGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

export type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;

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
  requesterRunSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
  assertCurrent?: () => void;
};

type RecordMediaGenerationTaskProgressParams = {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
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

type WakeMediaGenerationTaskCompletionParams = Omit<
  Parameters<typeof wakeMediaGenerationTaskCompletion>[0],
  "eventSource" | "announceType" | "toolName" | "completionLabel"
>;

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
    const delayMs = computeBackoffSchedule(
      MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS,
      retryIndex + 1,
    );
    await sleepWithAbort(Math.min(delayMs, remainingMs), undefined, { ref: false });
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
  return () => {
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
}

async function createMediaGenerationTaskRun(
  params: CreateMediaGenerationTaskRunParams & {
    toolName: string;
    taskKind: string;
    queuedProgressSummary: string;
  },
): Promise<MediaGenerationTaskHandle | null> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const requesterRunSessionKey = params.requesterRunSessionKey?.trim() || sessionKey;
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  const assertCurrent = captureMediaGenerationAdmission(params.assertCurrent);
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  assertCurrent();
  try {
    // Pin the complete requester route when detached work starts. Completion-time
    // session state can move to another peer while generation is still running.
    const cfg = getRuntimeConfig();
    const agentId = tryResolveSubagentRequesterAgentId(
      cfg,
      requesterRunSessionKey,
      params.requesterAgentId,
    );
    const canonicalKey = resolveRequesterStoreKey(
      cfg,
      requesterRunSessionKey,
      params.requesterAgentId,
    );
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
                requesterRunSessionKey === "main" ||
                requesterRunSessionKey === normalizeMainKey(cfg.session?.mainKey)
                  ? canonicalKey
                  : requesterRunSessionKey,
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

async function withMediaGenerationTaskKeepalive<T>(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (!params.handle) {
    return await params.run();
  }
  const interval = setInterval(() => {
    recordMediaGenerationTaskProgress({
      handle: params.handle,
      progressSummary: params.progressSummary,
    });
  }, MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS);
  interval.unref?.();
  try {
    return await params.run();
  } finally {
    clearInterval(interval);
  }
}

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

export function scheduleMediaGenerationTaskCompletion<
  T extends MediaGenerationExecutionResult,
>(params: {
  lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
  handle: MediaGenerationTaskHandle | null;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  progressSummary: string;
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

export function createMediaGenerationTaskLifecycle(kind: "image" | "music" | "video") {
  const taskKind = (
    {
      image: IMAGE_GENERATION_TASK_KIND,
      music: MUSIC_GENERATION_TASK_KIND,
      video: VIDEO_GENERATION_TASK_KIND,
    } as const
  )[kind];
  const toolName = `${kind}_generate`;
  const title = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return {
    createTaskRun(
      this: void,
      runParams: CreateMediaGenerationTaskRunParams,
    ): Promise<MediaGenerationTaskHandle | null> {
      return createMediaGenerationTaskRun({
        ...runParams,
        toolName,
        taskKind,
        queuedProgressSummary: `Queued ${kind} generation`,
      });
    },

    recordTaskProgress: recordMediaGenerationTaskProgress,

    completeTaskRun(params: CompleteMediaGenerationTaskRunParams) {
      if (!params.handle) {
        return;
      }
      try {
        const endedAt = Date.now();
        const generatedLabel = kind === "music" ? "track" : kind;
        const progressSummary = `Generated ${params.count} ${generatedLabel}${params.count === 1 ? "" : "s"}`;
        updateMediaGenerationOperation(params.handle.runId, {
          status: "succeeded",
          endedAt,
          lastEventAt: endedAt,
          progressSummary,
          terminalSummary:
            params.terminalResult?.terminalSummary ??
            `${progressSummary} with ${params.provider}/${params.model}.`,
          terminalOutcome: params.terminalResult?.terminalOutcome,
        });
      } finally {
        clearMediaGenerationTaskRunContext(params.handle);
      }
    },

    failTaskRun(params: FailMediaGenerationTaskRunParams) {
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
          progressSummary: `${title} generation failed`,
          terminalSummary: errorText,
        });
      } finally {
        clearMediaGenerationTaskRunContext(params.handle);
      }
    },

    async wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams) {
      return await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        eventSource: taskKind,
        announceType: `${kind} generation task`,
        toolName,
        completionLabel: kind,
      });
    },
  };
}
