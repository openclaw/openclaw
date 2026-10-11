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
import {
  createDeferredEmbeddedRunLifecycleManager,
  type DeferredEmbeddedRunLifecycleManager,
} from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { renderRateLimitOrOverloadedCopy } from "../../agents/failover/user-copy.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { leaseMcpAppModelContextForSessionTurn } from "../../agents/mcp-ui-resource.js";
import { resolveReplyExpectation } from "../../agents/reply-completion.js";
import { createAgentPatchedSessionModelRunGuard } from "../../agents/session-model-auto-revert.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { logVerbose } from "../../globals.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import {
  bindAgentRunTerminalWriteSettlement,
  drainAgentRunTerminalWrites,
} from "../../infra/agent-run-terminal-writes.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logSessionTurnCreated } from "../../logging/diagnostic.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { progressCardRefreshRunProjection } from "../../sessions/input-provenance.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { captureCommandOwnerAssertion } from "../command-owner-authority.js";
import type { PreparedReplyTranscriptStart } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../types.js";
import {
  clearRecoveredAutoFallbackPrimaryProbeSelection,
  resolveRunAfterAutoFallbackPrimaryProbeRecheck,
} from "./agent-runner-auto-fallback.js";
import { handleAgentExecutionError } from "./agent-runner-error-handler.js";
import {
  applyMcpAppModelContext,
  type AppContextTurnParams,
} from "./agent-runner-execution-mcp-context.js";
import { runAgentTurnWithOutcome } from "./agent-runner-execution-outcome.js";
import type {
  AgentTurnCompaction,
  AgentTurnExecutionResult,
  AgentTurnInternalResult,
  AgentTurnParams,
  InternalFollowupRun,
} from "./agent-runner-execution.types.js";
import {
  buildTerminalAgentRunFailureReplyPayload,
  markAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import { runAgentFallbackCandidates } from "./agent-runner-fallback-candidate.js";
import type {
  AgentFallbackCycleParams,
  AgentFallbackCycleResult,
  AgentFallbackCycleState,
} from "./agent-runner-fallback-cycle.types.js";
import { settleAgentFallbackCycle } from "./agent-runner-fallback-settlement.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { buildReplyMediaContextParams } from "./agent-runner-run-params.js";
import {
  createAgentTurnTimingTracker,
  resolveRunStartupPhase,
} from "./agent-runner-turn-timing.js";
import { resolveQueuedReplyRuntimeConfig } from "./agent-runner-utils.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { shouldNotifyUserAboutCompaction } from "./compaction-notice.js";
import { type CurrentTurnImages, resolveCurrentTurnImages } from "./current-turn-images.js";
import type { FollowupRun } from "./queue.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { resolveReplyFailureVisibility, type DirectBlockDelivery } from "./reply-delivery.js";
import { createReplyMediaContext, type ReplyMediaContext } from "./reply-media-paths.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import { resolveReplySessionEventDelivery } from "./reply-operation-run-state.js";
import {
  markReplyOperationExecutionStarted,
  retainReplyOperationUntilComplete,
} from "./reply-run-registry.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";

async function executeAgentTurnInternalLoop(
  inputParams: AppContextTurnParams,
  runId: string,
  commitTerminalOutcome: () => void,
  prepareMcpAppModelContext: () => Promise<AppContextTurnParams["mcpAppContextLease"]>,
  preparedRunAdmission: PreparedAgentRunAdmission,
  admittedRunContext: { current?: AdmittedRunContext },
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager,
  compaction: AgentTurnCompaction,
): Promise<AgentTurnInternalResult> {
  let params = inputParams;
  const heartbeatState = { didLogStrip: false };
  // Direct delivery receipts retain settlement facts across fallback candidates.
  const directBlockDeliveries: DirectBlockDelivery[] = [];
  // Queued turns reconciled their probe at admission. Rechecking it against
  // current preferences here would replace their already-owned model/auth route.
  const runnableRun =
    params.replyOperation?.turnKind === "queued_followup"
      ? params.followupRun.run
      : resolveRunAfterAutoFallbackPrimaryProbeRecheck({
          run: params.followupRun.run,
          entry:
            params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
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
    run.modelFallbackPolicy = err.modelFallbackPolicy;
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
  const messageProvider =
    params.followupRun.run.messageProvider ??
    params.sessionCtx.Surface ??
    params.sessionCtx.Provider;
  const shouldSurfaceToControlUi = isInternalMessageChannel(messageProvider);
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      ...(params.followupRun.run.sessionId ? { sessionId: params.followupRun.run.sessionId } : {}),
      agentId: params.followupRun.run.agentId,
      lifecycleGeneration,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      isControlUiVisible: shouldSurfaceToControlUi,
      ...progressCardRefreshRunProjection(params.followupRun.run.inputProvenance),
      completionSource: params.completionSource,
      sessionEventDelivery: resolveReplySessionEventDelivery(params.opts, params.followupRun.run),
    });
    bindAgentRunTerminalWriteSettlement(preparedRunAdmission.operationalRunInstance);
  }
  if (isDiagnosticsEnabled(runtimeConfig)) {
    logSessionTurnCreated({
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.followupRun.run.sessionId,
      agentId: params.followupRun.run.agentId,
      channel: messageProvider,
      trigger: resolveReplyRunTrigger(params),
    });
  }
  let replyMediaContext: ReplyMediaContext;
  let currentTurnImages: CurrentTurnImages;
  let modelPatch: Awaited<ReturnType<typeof createAgentPatchedSessionModelRunGuard>>;
  try {
    replyMediaContext =
      params.replyMediaContext ??
      agentTurnTiming.measureSync("reply_media_context", () =>
        createReplyMediaContext(
          buildReplyMediaContextParams(params.followupRun, params.sessionKey, runtimeConfig),
        ),
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
  // Failed candidates cannot lend prepared facts or late callbacks to their successor.
  const createAgentRunStartCallbacks = () => {
    let active = true;
    let preparedTranscriptStart: PreparedReplyTranscriptStart | null | undefined =
      params.opts?.onAgentRunStart && params.sessionKey ? undefined : null;
    let transcriptStartPreparation: Promise<void> | undefined;
    const prepareAgentRunStart = () => {
      if (
        !active ||
        didNotifyAgentRunStart ||
        preparedTranscriptStart !== undefined ||
        !params.sessionKey
      ) {
        return undefined;
      }
      if (transcriptStartPreparation) {
        return transcriptStartPreparation;
      }
      const target = {
        agentId: effectiveRun.agentId,
        sessionId: params.replyOperation?.sessionId ?? effectiveRun.sessionId,
        sessionKey: params.sessionKey,
        storePath:
          params.storePath ??
          resolveSessionStorePathCore(runtimeConfig.session?.store, {
            agentId: effectiveRun.agentId,
          }),
      };
      return (transcriptStartPreparation = (async () => {
        using _ = agentTurnTiming.observe(params.opts?.onTranscriptStartPreparation);
        const { readSessionTranscriptStartAsync } =
          await import("../../config/sessions/session-transcript-watermark.js");
        const prepared = await readSessionTranscriptStartAsync(target);
        preparedRunAdmission.assertSourceCurrent();
        params.opts?.abortSignal?.throwIfAborted();
        params.replyOperation?.abortSignal?.throwIfAborted();
        if (active && !didNotifyAgentRunStart) {
          preparedTranscriptStart = prepared;
        }
      })());
    };
    const notifyAgentRunStart = (transcriptStart?: PreparedReplyTranscriptStart | null) => {
      const prepared = transcriptStart === undefined ? preparedTranscriptStart : transcriptStart;
      if (!active || didNotifyAgentRunStart || prepared === undefined) {
        return;
      }
      didNotifyAgentRunStart = true;
      if (params.replyOperation) {
        markReplyOperationExecutionStarted(params.replyOperation);
      }
      params.followupRun.run.internalEventExecution?.onStarted(runId);
      params.opts?.onAgentRunStart?.(
        runId,
        admittedRunContext.current?.executionIdentityToken,
        undefined,
        prepared,
      );
    };
    const signalExecutionPhaseForTyping = (
      info: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0],
    ) => {
      if (!active) {
        return;
      }
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
    return {
      prepareAgentRunStart,
      notifyAgentRunStart,
      signalExecutionPhaseForTyping,
      close: () => {
        active = false;
      },
    };
  };
  const notifyUserAboutCompaction = shouldNotifyUserAboutCompaction(runtimeConfig);
  let cycle: AgentFallbackCycleResult;
  let liveModelSwitchRetries = 0;
  const fallbackCycleState: AgentFallbackCycleState = {
    deferredLifecycle,
    lifecycleGeneration,
    turnStartedAtMs: Date.now(),
    compaction,
    postCompactionModelAttempted: false,
    attemptedRuntimeProvider: params.followupRun.run.provider,
    attemptedRuntimeModel: params.followupRun.run.model,
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
      const cycleParams: AgentFallbackCycleParams = {
        preparedRunAdmission,
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
        createAgentRunStartCallbacks,
        notifyUserAboutCompaction,
        timing: agentTurnTiming,
        modelPatch,
        shouldSurfaceToControlUi,
        commitTerminalOutcome,
        clearRecoveredAutoFallbackPrimaryProbe,
      };
      const fallbackResult = await runAgentFallbackCandidates(cycleParams);
      cycleParams.timing.logIfSlow({
        runId: cycleParams.runId,
        sessionId: cycleParams.turn.followupRun.run.sessionId,
        sessionKey: cycleParams.turn.sessionKey,
        outcome: "completed",
      });
      cycle = await settleAgentFallbackCycle({ cycle: cycleParams, fallbackResult });
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
      if (action.kind !== "retry") {
        cycle = action;
      } else {
        if (action.liveModelSwitchError) {
          for (const run of new Set([params.followupRun.run, runnableRun, effectiveRun])) {
            applyLiveModelSwitchToRun(run, action.liveModelSwitchError);
          }
        }
        continue;
      }
    }
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
    break;
  }
  const {
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    terminalRunFailed,
  } = cycle;

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
      isHeartbeat: params.isHeartbeat,
      useHeartbeatFailureCopy: params.opts?.useHeartbeatFailureCopy,
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
    sessionWriter: fallbackCycleState.sessionWriter,
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
    modelContextLease = executionParams.isHeartbeat
      ? undefined
      : await leaseMcpAppModelContextForSessionTurn({
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
        const admittedRunContext: { current?: AdmittedRunContext } = {};
        const gatewayContextResolver =
          readChannelContextGatewayContextResolver(executionParams.sessionCtx) ??
          getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
        const preparedRunAdmission = prepareChannelRunAdmission({
          sourceContext: executionParams.followupRun.run,
          cfg: resolveQueuedReplyRuntimeConfig(executionParams.followupRun.run.config),
          runId,
          agentId: executionParams.followupRun.run.agentId,
          ingressKind: "channel",
          boundary: "auto-reply.agent-runner",
          operatorAuthority: executionParams.followupRun.operatorAuthority,
          evidence: executionParams.followupRun.channelAdmissionEvidence,
          gatewayLocalUserIngress: executionParams.followupRun.gatewayLocalUserIngress,
          assertSourceCurrent: composeSessionSourceAssertion([
            executionParams.followupRun.run.senderIsOwner === true
              ? captureCommandOwnerAssertion(executionParams.followupRun.run)
              : undefined,
            executionParams.followupRun.run.internalEventExecution?.assertCurrent,
          ]),
          onAdmitted: (context) => {
            bindGatewayContextResolver(context, gatewayContextResolver);
            admittedRunContext.current = context;
            executionParams.followupRun.run.skillLibraryAuthoring?.bind(context);
          },
        });
        const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
          runId,
          agentId: executionParams.followupRun.run.agentId,
          sessionId: executionParams.followupRun.run.sessionId,
          sessionKey: executionParams.sessionKey,
          sessionFile: executionParams.followupRun.run.sessionFile,
          abortSignal: resolveFollowupAbortSignal({
            abortSignal:
              executionParams.replyOperation?.abortSignal ?? executionParams.opts?.abortSignal,
            operatorAuthority: executionParams.followupRun.operatorAuthority,
          }),
        });
        try {
          return await executeAgentTurnInternalLoop(
            executionParams,
            runId,
            commitTerminalOutcome,
            prepareMcpAppModelContext,
            preparedRunAdmission,
            admittedRunContext,
            deferredLifecycle,
            compaction,
          );
        } finally {
          try {
            await deferredLifecycle.complete();
          } finally {
            await drainAgentRunTerminalWrites(preparedRunAdmission.operationalRunInstance).finally(
              preparedRunAdmission.close,
            );
          }
        }
      } finally {
        modelContextLease?.rollback();
        commitTerminalOutcome();
      }
    });
    const abortReason =
      internal.kind !== "aborted" &&
      resolveReplyOperationAbortReason(executionParams.replyOperation);
    if (abortReason) {
      return { runId, outcome: { kind: "aborted", reason: abortReason, ...completedCompaction() } };
    }
    const outcome: AgentTurnExecutionResult["outcome"] =
      internal.kind === "final"
        ? {
            kind: "rejected",
            payload: internal.payload,
            resolved: internal.resolved,
            ...(internal.postCompactionModelFailure
              ? { postCompactionModelFailure: internal.postCompactionModelFailure }
              : {}),
          }
        : internal;
    return {
      runId,
      outcome: { ...outcome, ...completedCompaction() },
    };
  } catch (error) {
    const abortReason = resolveReplyOperationAbortReason(executionParams.replyOperation, error);
    if (abortReason) {
      return { runId, outcome: { kind: "aborted", reason: abortReason, ...completedCompaction() } };
    }
    throw error;
  }
}

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
  return await runAgentTurnWithOutcome(executionParams, runId, () =>
    executeAgentTurnOutcome(executionParams, runId),
  );
}
