/** Agent-runner execution loop, fallback handling, and user-facing failure mapping. */
import crypto from "node:crypto";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { classifyFailoverReason } from "../../agents/embedded-agent-helpers.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { renderRateLimitOrOverloadedCopy } from "../../agents/failover/user-copy.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { leaseMcpAppModelContextForSessionTurn } from "../../agents/mcp-ui-resource.js";
import { resolveReplyExpectation } from "../../agents/reply-completion.js";
import { createAgentPatchedSessionModelRunGuard } from "../../agents/session-model-auto-revert.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { logVerbose } from "../../globals.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logSessionTurnCreated } from "../../logging/diagnostic.js";
import { progressCardRefreshRunProjection } from "../../sessions/input-provenance.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { ReplyPayload } from "../types.js";
import { prepareReplyTurnExecution } from "./agent-runner-admission.js";
import {
  clearRecoveredAutoFallbackPrimaryProbeSelection,
  resolveRunAfterAutoFallbackPrimaryProbeRecheck,
} from "./agent-runner-auto-fallback.js";
import { handleAgentExecutionError } from "./agent-runner-error-handler.js";
import {
  applyMcpAppModelContext,
  type AppContextTurnParams,
} from "./agent-runner-execution-mcp-context.js";
import { recordAgentTurnExecutionOutcome } from "./agent-runner-execution-outcome.js";
import type {
  AgentTurnCompaction,
  AgentTurnExecutionResult,
  AgentTurnInternalResult,
  AgentTurnParams,
  InternalFollowupRun,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import {
  buildTerminalAgentRunFailureReplyPayload,
  markAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import {
  executeAgentFallbackCycle,
  type AgentFallbackCycleState,
} from "./agent-runner-fallback-cycle.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import {
  createAgentTurnTimingTracker,
  resolveRunStartupPhase,
} from "./agent-runner-turn-timing.js";
import { resolveQueuedReplyRuntimeConfig } from "./agent-runner-utils.js";
import { shouldNotifyUserAboutCompaction } from "./compaction-notice.js";
import { type CurrentTurnImages, resolveCurrentTurnImages } from "./current-turn-images.js";
import type { FollowupRun } from "./queue.js";
import { resolveReplyFailureVisibility, type DirectBlockDelivery } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { createReplyMediaContext } from "./reply-media-paths.runtime.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import {
  markReplyOperationExecutionStarted,
  retainReplyOperationUntilComplete,
} from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";

async function executeAgentTurnInternalLoop(
  inputParams: AppContextTurnParams,
  runId: string,
  commitTerminalOutcome: () => void,
  prepareMcpAppModelContext: () => Promise<AppContextTurnParams["mcpAppContextLease"]>,
  preparedRunAdmission: PreparedAgentRunAdmission,
  admittedRunContext: { current?: AdmittedRunContext },
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager,
  compaction: AgentTurnCompaction,
  scheduledMessageActionTurnCapability?: string,
): Promise<AgentTurnInternalResult> {
  let params = inputParams;
  const heartbeatState = { didLogStrip: false };
  // Direct delivery receipts retain settlement facts across fallback candidates.
  const directBlockDeliveries: DirectBlockDelivery[] = [];
  const runnableRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
    run: params.followupRun.run,
    entry: params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
    sessionKey: params.sessionKey,
  });
  if (runnableRun !== params.followupRun.run) {
    params.followupRun.run = runnableRun;
  }
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(runnableRun.config);
  const effectiveRun =
    runtimeConfig === runnableRun.config
      ? runnableRun
      : {
          ...runnableRun,
          config: runtimeConfig,
        };
  let liveModelSwitchRuntimeEntry:
    | Pick<
        SessionEntry,
        "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked" | "pluginOwnerId"
      >
    | undefined;
  const applyLiveModelSwitchToRun = (
    run: FollowupRun["run"],
    err: LiveSessionModelSwitchError,
  ): void => {
    run.provider = err.provider;
    run.model = err.model;
    run.authProfileId = err.authProfileId;
    run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : undefined;
    run.autoFallbackPrimaryProbe = undefined;
    // Keep runtime paired with the error's model/auth winner even if the
    // active in-memory session snapshot lags the persisted directive write.
    liveModelSwitchRuntimeEntry = { agentRuntimeOverride: err.agentRuntimeOverride };
  };

  const agentTurnTiming = createAgentTurnTimingTracker({
    profilerEnabled: isReplyProfilerEnabled({ config: runtimeConfig }),
  });
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      ...(params.followupRun.run.sessionId ? { sessionId: params.followupRun.run.sessionId } : {}),
      agentId: params.followupRun.run.agentId,
      lifecycleGeneration,
      verboseLevel: params.resolvedVerboseLevel,
      isControlUiVisible: shouldSurfaceToControlUi,
      ...progressCardRefreshRunProjection(params.followupRun.run.inputProvenance),
      completionSource: params.completionSource,
    });
  }
  if (isDiagnosticsEnabled(runtimeConfig)) {
    logSessionTurnCreated({
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.followupRun.run.sessionId,
      agentId: params.followupRun.run.agentId,
      channel:
        params.followupRun.run.messageProvider ??
        params.sessionCtx.Surface ??
        params.sessionCtx.Provider,
      trigger: params.followupRun.run.scheduledAutomation
        ? "cron"
        : params.followupRun.run.internalEventExecution
          ? "event"
          : "user",
    });
  }
  let replyMediaContext: ReplyMediaContext;
  let currentTurnImages: CurrentTurnImages;
  let modelPatch: Awaited<ReturnType<typeof createAgentPatchedSessionModelRunGuard>>;
  try {
    replyMediaContext =
      params.replyMediaContext ??
      agentTurnTiming.measureSync("reply_media_context", () =>
        createReplyMediaContext({
          cfg: runtimeConfig,
          agentId: params.followupRun.run.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.followupRun.run.workspaceDir,
          mediaNormalizationOwner: params.followupRun.run.mediaNormalizationOwner,
          messageProvider: params.followupRun.run.messageProvider,
          accountId:
            params.followupRun.originatingAccountId ?? params.followupRun.run.agentAccountId,
          groupId: params.followupRun.run.groupId,
          groupChannel: params.followupRun.run.groupChannel,
          groupSpace: params.followupRun.run.groupSpace,
          requesterSenderId: params.followupRun.run.senderId,
          requesterSenderName: params.followupRun.run.senderName,
          requesterSenderUsername: params.followupRun.run.senderUsername,
          requesterSenderE164: params.followupRun.run.senderE164,
        }),
      );
    const internalFollowupRun = params.followupRun as InternalFollowupRun;
    const hasQueuedCurrentTurnImages =
      internalFollowupRun.currentTurnImagesPrepared === true ||
      Object.hasOwn(params.followupRun, "images") ||
      Object.hasOwn(params.followupRun, "imageOrder");
    // Queue admission owns current-turn materialization, including empty results.
    // Re-scanning here can resurrect suppressed media or duplicate loaded images.
    currentTurnImages = hasQueuedCurrentTurnImages
      ? {
          images: params.followupRun.images,
          imageOrder: params.followupRun.imageOrder,
          mediaImageLayout: internalFollowupRun.mediaImageLayout,
        }
      : await agentTurnTiming.measure("current_turn_images", () =>
          resolveCurrentTurnImages({
            ctx: params.sessionCtx,
            cfg: runtimeConfig,
            images: params.opts?.images,
            imageOrder: params.opts?.imageOrder,
          }),
        );
    const modelContextLease = await prepareMcpAppModelContext();
    if (modelContextLease) {
      params = { ...params, mcpAppContextLease: modelContextLease };
    }
    ({ params, currentTurnImages } = applyMcpAppModelContext(params, currentTurnImages));
    modelPatch = await createAgentPatchedSessionModelRunGuard({
      cfg: runtimeConfig,
      agentId: params.followupRun.run.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      assertReadCurrent: () => {
        params.replyOperation?.abortSignal?.throwIfAborted();
        params.opts?.abortSignal?.throwIfAborted();
        preparedRunAdmission.assertSourceCurrent();
      },
      onError: (error) =>
        logVerbose(`agent model patch reconciliation failed: ${formatErrorMessage(error)}`),
    });
  } catch (error) {
    clearAgentRunContext(runId, lifecycleGeneration);
    throw error;
  }
  let didNotifyAgentRunStart = false;
  let lastRunStartupPhase: ReturnType<typeof resolveRunStartupPhase>;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    if (params.replyOperation) {
      markReplyOperationExecutionStarted(params.replyOperation);
    }
    params.followupRun.run.internalEventExecution?.onStarted(runId);
    params.opts?.onAgentRunStart?.(runId, admittedRunContext.current?.executionIdentityToken);
  };
  const signalExecutionPhaseForTyping = (
    info: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0],
  ) => {
    agentTurnTiming.logExecutionPhaseIfSlow({
      runId,
      sessionId: params.followupRun.run.sessionId,
      sessionKey: params.sessionKey,
      phase: info.phase,
    });
    const startupPhase = resolveRunStartupPhase(info.phase);
    if (startupPhase && startupPhase !== lastRunStartupPhase) {
      lastRunStartupPhase = startupPhase;
      emitAgentRunStatusEvent({ runId, phase: startupPhase });
    }
    if (
      info.phase === "turn_accepted" ||
      info.phase === "model_call_started" ||
      info.phase === "process_spawned"
    ) {
      params.mcpAppContextLease?.commit();
    }
    const isUserVisibleExecutionActivity =
      info.phase === "turn_accepted" ||
      info.phase === "process_spawned" ||
      info.phase === "model_call_started" ||
      info.phase === "tool_execution_started" ||
      info.phase === "assistant_output_started";
    if (!isUserVisibleExecutionActivity) {
      return;
    }
    notifyAgentRunStart();
    void (
      params.typingSignals.signalExecutionActivity?.() ?? params.typingSignals.signalRunStart()
    ).catch((err: unknown) => {
      logVerbose(`execution phase typing signal failed: ${String(err)}`);
    });
  };
  const notifyUserAboutCompaction = shouldNotifyUserAboutCompaction(runtimeConfig);
  let runResult: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let fallbackExhausted = false;
  let terminalRunFailed = false;
  let liveModelSwitchRetries = 0;
  const fallbackCycleState: AgentFallbackCycleState = {
    deferredLifecycle,
    lifecycleGeneration,
    turnStartedAtMs: Date.now(),
    compaction,
    postCompactionModelAttempted: false,
    attemptedRuntimeProvider: fallbackProvider,
    attemptedRuntimeModel: fallbackModel,
    bootstrapPromptWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeen(
      params.getActiveSessionEntry()?.systemPromptReport,
    ),
  };
  const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear: {
    provider: string;
    model: string;
  }): Promise<void> =>
    clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: effectiveRun,
      ...paramsForClear,
      sessionKey: params.sessionKey,
      activeSessionStore: params.activeSessionStore,
      getActiveSessionEntry: params.getActiveSessionEntry,
      storePath: params.storePath,
    });

  while (true) {
    try {
      const presentation = createAgentTurnPresentation({
        turn: params,
        replyMediaContext,
        directBlockDeliveries,
        heartbeatState,
      });
      const cycle = await executeAgentFallbackCycle({
        preparedRunAdmission,
        scheduledMessageActionTurnCapability,
        turn: params,
        effectiveRun,
        runtimeConfig,
        liveModelSwitchRuntimeEntry,
        runId,
        runAbortSignal: fallbackCycleState.deferredLifecycle.signal,
        currentTurnImages,
        state: fallbackCycleState,
        presentation,
        directBlockDeliveries,
        notifyAgentRunStart,
        signalExecutionPhaseForTyping,
        notifyUserAboutCompaction,
        timing: agentTurnTiming,
        modelPatch,
        shouldSurfaceToControlUi,
        commitTerminalOutcome,
        clearRecoveredAutoFallbackPrimaryProbe,
      });
      if (cycle.kind === "aborted") {
        return cycle;
      }
      if (cycle.kind === "final") {
        return {
          ...cycle,
          resolved: {
            provider: fallbackCycleState.attemptedRuntimeProvider,
            model: fallbackCycleState.attemptedRuntimeModel,
          },
        };
      }
      runResult = cycle.runResult;
      fallbackProvider = cycle.fallbackProvider;
      fallbackModel = cycle.fallbackModel;
      fallbackExhausted = cycle.fallbackExhausted;
      fallbackAttempts = cycle.fallbackAttempts;
      terminalRunFailed = cycle.terminalRunFailed;
      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        liveModelSwitchRetries += 1;
      }
      const action = await handleAgentExecutionError({
        turn: params,
        error: err,
        runtimeConfig,
        runId,
        state: fallbackCycleState,
        liveModelSwitchRetries,
        shouldSurfaceToControlUi,
        timing: agentTurnTiming,
        modelPatch,
        resolveVisibleReplyDelivery: () =>
          resolveReplyFailureVisibility(params.resolveVisibleReplyDelivery, directBlockDeliveries),
      });
      if (action.kind === "aborted") {
        return action;
      }
      if (action.kind === "final") {
        return {
          ...action,
          resolved: {
            provider: fallbackCycleState.attemptedRuntimeProvider,
            model: fallbackCycleState.attemptedRuntimeModel,
          },
        };
      }
      if (action.liveModelSwitchError) {
        const switchError = action.liveModelSwitchError;
        applyLiveModelSwitchToRun(params.followupRun.run, switchError);
        if (runnableRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(runnableRun, switchError);
        }
        if (effectiveRun !== runnableRun && effectiveRun !== params.followupRun.run) {
          applyLiveModelSwitchToRun(effectiveRun, switchError);
        }
      }
      continue;
    }
  }

  // Preserve successful content and formatted tool errors. Mid-turn provider failures
  // still pass through normal payload filtering and accounting (#36142).
  const hasNonErrorContent = runResult.payloads?.some(
    (p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }),
  );
  if (!hasNonErrorContent) {
    const metaErrorMsg = runResult.meta?.error?.message ?? "";
    const rawErrorPayloadText =
      runResult.payloads?.find(
        (p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"),
      )?.text ?? "";
    const errorCandidate = metaErrorMsg || rawErrorPayloadText;
    const candidateReason = errorCandidate ? classifyFailoverReason(errorCandidate) : null;
    const formattedErrorCandidate =
      candidateReason === "rate_limit" || candidateReason === "overloaded"
        ? renderRateLimitOrOverloadedCopy({ reason: candidateReason, raw: errorCandidate })
        : undefined;
    if (formattedErrorCandidate) {
      runResult.payloads = [
        markAgentRunFailureReplyPayload({
          text: formattedErrorCandidate,
          isError: true,
        }),
      ];
    }
  }
  const patchedModelNeedsRevert = terminalRunFailed
    ? false
    : (modelPatch.captureFallbackFailure(fallbackAttempts) ?? false);
  await modelPatch.finish(!terminalRunFailed && !patchedModelNeedsRevert);
  let terminalFailurePayload: ReplyPayload | undefined;
  if (terminalRunFailed) {
    const replyExpectation = resolveReplyExpectation(params.followupRun.run);
    terminalFailurePayload = buildTerminalAgentRunFailureReplyPayload({
      replyExpectation,
      visibleReplyDelivered:
        replyExpectation === "optional"
          ? await resolveReplyFailureVisibility(
              params.resolveVisibleReplyDelivery,
              directBlockDeliveries,
            )
          : false,
    });
  }

  return {
    kind: "settled",
    maintenanceAuthProfile: fallbackCycleState.maintenanceAuthProfile,
    compactionRequestBudget: fallbackCycleState.compactionRequestBudget,
    result: runResult,
    resolved: { provider: fallbackProvider, model: fallbackModel },
    fallback: { exhausted: fallbackExhausted, attempts: fallbackAttempts },
    didLogHeartbeatStrip: heartbeatState.didLogStrip,
    autoCompactionCount: compaction.count,
    hasDirectlySentBlockReply:
      directBlockDeliveries.some((delivery) => delivery.terminalDeliveryConfirmed === true) ||
      undefined,
    directBlockDeliveries,
    ...(terminalFailurePayload
      ? {
          status: "failed" as const,
          terminalFailurePayload,
          ...(fallbackCycleState.postCompactionModelAttempted
            ? { postCompactionModelFailure: true as const }
            : {}),
        }
      : { status: "ok" as const }),
  };
}

async function executeAgentTurnInternal(
  params: AppContextTurnParams,
  runId: string,
  commitTerminalOutcome: () => void,
  prepareMcpAppModelContext: () => Promise<AppContextTurnParams["mcpAppContextLease"]>,
  compaction: AgentTurnCompaction,
): Promise<AgentTurnInternalResult> {
  const execution = prepareReplyTurnExecution(params, runId);
  const {
    preparedRunAdmission,
    admittedRunContext,
    deferredLifecycle,
    scheduledMessageActionTurnCapability,
  } = execution;
  try {
    return await executeAgentTurnInternalLoop(
      params,
      runId,
      commitTerminalOutcome,
      prepareMcpAppModelContext,
      preparedRunAdmission,
      admittedRunContext,
      deferredLifecycle,
      compaction,
      scheduledMessageActionTurnCapability,
    );
  } finally {
    await execution.close();
  }
}

/** Runs the agent turn with provider/model fallback, retry, and closed settlement. */
async function executeAgentTurnOutcome(
  executionParams: AppContextTurnParams,
  runId: string,
): Promise<AgentTurnExecutionResult> {
  const requester = executionParams.followupRun.operatorAuthority;
  if (requester) {
    assertAdmittedRunOperatorAuthority(requester);
    requester.assertCurrent();
  }
  let modelContextLease: AppContextTurnParams["mcpAppContextLease"];
  const prepareMcpAppModelContext = async () => {
    requester?.assertCurrent();
    modelContextLease = await leaseMcpAppModelContextForSessionTurn({
      agentId: executionParams.followupRun.run.agentId,
      sessionId: executionParams.followupRun.run.sessionId,
      sessionKey: executionParams.sessionKey ?? executionParams.followupRun.run.sessionKey,
      requesterId: requester?.profileId,
    });
    requester?.assertCurrent();
    return modelContextLease;
  };
  // Keep committed facts outside cleanup so a restart cannot erase them.
  const compaction: AgentTurnCompaction = { count: 0, durable: [] };
  const completedCompaction = () =>
    compaction.count > 0
      ? { compaction: { count: compaction.count, durable: [...compaction.durable] } }
      : {};
  let terminalOutcomeCommitted = false;
  // Settlement freezes cancellation once, including failure exits through finally.
  const commitTerminalOutcome = () => {
    if (terminalOutcomeCommitted) {
      return;
    }
    terminalOutcomeCommitted = true;
    executionParams.replyOperation?.freezeAbort();
  };
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  try {
    const internal = await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
      try {
        return await executeAgentTurnInternal(
          executionParams,
          runId,
          commitTerminalOutcome,
          prepareMcpAppModelContext,
          compaction,
        );
      } finally {
        modelContextLease?.rollback();
        commitTerminalOutcome();
      }
    });
    if (internal.kind === "aborted") {
      return { runId, outcome: { ...internal, ...completedCompaction() } };
    }
    const abortReason = resolveReplyOperationAbortReason(executionParams.replyOperation);
    if (abortReason) {
      return { runId, outcome: { kind: "aborted", reason: abortReason, ...completedCompaction() } };
    }
    if (internal.kind === "final") {
      return {
        runId,
        outcome: {
          kind: "rejected",
          payload: internal.payload,
          resolved: internal.resolved,
          ...(internal.postCompactionModelFailure
            ? { postCompactionModelFailure: internal.postCompactionModelFailure }
            : {}),
          ...completedCompaction(),
        },
      };
    }
    return {
      runId,
      outcome: { ...internal, ...completedCompaction() },
    };
  } catch (error) {
    const abortReason = resolveReplyOperationAbortReason(executionParams.replyOperation, error);
    if (abortReason) {
      return { runId, outcome: { kind: "aborted", reason: abortReason, ...completedCompaction() } };
    }
    throw error;
  }
}

/** Runs the agent turn and records its execution and message-tool delivery outcomes. */
export async function executeAgentTurn(params: AgentTurnParams): Promise<AgentTurnExecutionResult> {
  params.opts?.onRunVerbosityResolved?.({
    verboseLevelOverride: params.followupRun.run.verboseLevelOverride,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
  });
  if (params.replyOperation) {
    // Cancellation stops execution, but the exact owner must finish committed accounting first.
    retainReplyOperationUntilComplete(params.replyOperation);
  }
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const executionParams =
    params.opts?.runId === runId ? params : { ...params, opts: { ...params.opts, runId } };
  const automation = executionParams.followupRun.run.scheduledAutomation;
  const eventExecution = executionParams.followupRun.run.internalEventExecution;
  let releaseCronSource: (() => void) | undefined;
  let runContextOwnerToken: string | undefined;
  let terminalRecorded = false;
  try {
    await eventExecution?.beforeStart?.();
    executionParams.replyOperation?.abortSignal.throwIfAborted();
    automation?.assertCurrent();
    if (automation) {
      runContextOwnerToken = claimAgentRunContext(
        runId,
        {
          sessionKey: executionParams.sessionKey ?? executionParams.followupRun.run.sessionKey,
          sessionId: executionParams.followupRun.run.sessionId,
          agentId: executionParams.followupRun.run.agentId,
          lifecycleGeneration: captureAgentRunLifecycleGeneration(runId),
          cronRunsByJobId: new Map([
            [
              automation.job.id,
              {
                pacingEnabled: automation.job.pacing !== undefined,
                assertCurrent: () => {
                  automation.assertCurrent();
                  if (
                    !executionParams.replyOperation ||
                    executionParams.replyOperation.result ||
                    executionParams.replyOperation.abortSignal.aborted
                  ) {
                    throw new Error("Automation reply owner has closed");
                  }
                },
              },
            ],
          ]),
        },
        { trackOwner: true, ownsContext: true },
      );
      if (!runContextOwnerToken) {
        throw new Error("The scheduled run context already has an exclusive owner");
      }
    }
    releaseCronSource = automation
      ? registerCronRunExecSource(runId, {
          agentId: executionParams.followupRun.run.agentId,
          jobId: automation.job.id,
          jobName: automation.job.name,
          jobConfigRevision: resolveCronJobConfigRevision(automation.job),
        })
      : undefined;
    const result = await executeAgentTurnOutcome(executionParams, runId);
    await recordAgentTurnExecutionOutcome(executionParams, result);
    terminalRecorded = true;
    await eventExecution?.onTerminal(
      runId,
      result.outcome.kind === "aborted"
        ? "aborted"
        : result.outcome.kind === "settled" && result.outcome.status === "ok"
          ? "completed"
          : "failed",
      result.outcome.kind === "settled" ? result.outcome.result : undefined,
    );
    return result;
  } catch (error) {
    if (!terminalRecorded) {
      await recordAgentTurnExecutionOutcome(executionParams, undefined);
      await eventExecution?.onTerminal(runId, "failed");
    }
    throw error;
  } finally {
    releaseCronSource?.();
    releaseAgentRunContext(runId, runContextOwnerToken);
  }
}
