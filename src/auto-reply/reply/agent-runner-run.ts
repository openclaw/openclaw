import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import {
  isRequiredReplyExpectation,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import { isUserInitiatedAgentRunAbortReason } from "../../agents/run-termination.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { isChannelRunAuthorizationError } from "../../channels/message-access/run-authorization-error.js";
import { logVerbose } from "../../globals.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  submitSessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { hasReplySteeringRequesterMismatch } from "../../sessions/session-controller.message-join.js";
import { isExplicitFollowupCommandTurn } from "../command-turn-context.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  BLOCK_REPLY_SEND_TIMEOUT_MS,
  cleanupReplyAgentRun,
  handleReplyAgentRunError,
  type RunReplyAgentParams,
  scheduleFollowupDrainAfterReplyOperationClear,
} from "./agent-runner-core.js";
import {
  continueStalledReplyTurn,
  executePreparedReplyAgentRun,
  prependCompactionNotices,
} from "./agent-runner-execute.js";
import { createShouldEmitToolOutput, createShouldEmitToolResult } from "./agent-runner-helpers.js";
import {
  prepareReplyRunOptions,
  prepareReplyRunPresentation,
} from "./agent-runner-presentation.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { touchQueuedReplySessionActivity } from "./agent-runner-session-activity.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { recordGroupParticipationInput } from "./group-participation-inputs.js";
import { readGroupParticipationRun } from "./group-participation-run.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "./queue.js";
import { refuseCollaborativeSteering } from "./queue/lifecycle.js";
import { bindReplyOperationQueueDisposition, resolveFollowupAbortSignal } from "./queue/types.js";
import { prepareReplyAgentTurn } from "./reply-agent-turn-preparation.js";
import { createReplyInputAdmission } from "./reply-input-admission.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { enqueueReplySourceAdmission } from "./reply-source-admission.js";
import { bindReplySourceToFollowup, retireUnadoptedReplySource } from "./reply-source-binding.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission-lifecycle.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
import { createTypingSignaler } from "./typing-mode.js";
export async function runReplyAgent(
  params: RunReplyAgentParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    hasQueuedFollowups = false,
    isActive,
    isRunActive,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    resolvedVerboseLevel,
    toolProgressDetail,
    isNewSession,
    blockStreamingEnabled,
    sessionCtx,
    typingMode,
    resetTriggered = false,
    replyOperation: providedReplyOperation,
  } = params;
  followupRun.run.agentId ??= resolveDefaultAgentId(followupRun.run.config);
  followupRun.turnAdoptionLifecycle ??= opts?.turnAdoptionLifecycle;
  bindReplySourceToFollowup(opts, followupRun);
  const runId = opts?.runId ?? randomUUID();
  const controllerInput = submitSessionControllerInput(queueKey, followupRun, resolvedQueue, {
    protocolRunId: runId,
    storePath,
  });
  let immediateClaim: SessionControllerMailboxClaim | undefined;
  const upstreamSignals = [
    controllerInput.abortSignal,
    followupRun.abortSignal,
    opts?.abortSignal,
    followupRun.turnAdoptionLifecycle?.abortSignal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  followupRun.abortSignal =
    upstreamSignals.length > 1 ? AbortSignal.any(upstreamSignals) : upstreamSignals[0];
  const preparationResources: { stopBlockReply?: () => void } = {};
  const inputGeneration = getAgentEventLifecycleGeneration();
  try {
    followupRun.operatorAuthority?.assertCurrent();
    const resolveGatewayContext = providedReplyOperation
      ? getGatewayContextResolver(providedReplyOperation)
      : (readChannelContextGatewayContextResolver(sessionCtx) ??
        getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
    let activeSessionEntry = sessionEntry;
    let activeSessionStore = sessionStore;

    const replyExpectation = (followupRun.run.terminalReplyExpectation ??=
      resolveSourceReplyExpectation({
        ctx: {
          ...sessionCtx,
          InboundEventKind: followupRun.currentInboundEventKind ?? sessionCtx.InboundEventKind,
          InputProvenance: followupRun.run.inputProvenance ?? sessionCtx.InputProvenance,
        },
        cfg: followupRun.run.config,
        scheduledAutomation: followupRun.run.scheduledAutomation !== undefined,
      }));
    const explicitFollowup = isExplicitFollowupCommandTurn(sessionCtx);
    if (explicitFollowup) {
      followupRun.disableCollectBatching = true;
    }
    const replyOperationRunState = replyRunState.resolveReplyOperationRunState(opts);
    if (replyOperationRunState) {
      replyOperationRunState.sourceSettlement = controllerInput.settlement.promise;
    }
    const { runOptions: runOpts, hasVisiblePartialReply } = prepareReplyRunOptions({
      opts,
      runId: controllerInput.protocolRunId ?? runId,
      abortSignal: followupRun.abortSignal,
      onVisiblePartialReply: () =>
        controllerInput.claim?.operation?.watchdog.progress(
          "finalization",
          "reply:partial_delivered",
        ),
    });
    if (replyOperationRunState && isRequiredReplyExpectation(replyExpectation)) {
      // Preparation has not transferred the accepted input into an executable turn yet.
      replyOperationRunState.continueStalledTurn = () => false;
    }
    if (replyOperationRunState) {
      replyOperationRunState.replyCompletion = resolveReplyCompletion(
        followupRun.run.terminalReplyExpectation,
        "empty",
      );
    }
  };

  const queuedRunFollowupTurn = createFollowupRunner({
    resolveGatewayContext,
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    toolProgressDetail,
  });

  if (messageInjectionDisposition === "accepted") {
    recordGroupParticipationInput(activeReplyOperation, followupRun, "steer");
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "steer" };
    }
    releaseAdmissionTicket();
    typing.cleanup();
    return undefined;
  }

  const bindQueueDisposition = () => {
    const observe = followupRun.onQueueDisposition;
    followupRun.onQueueDisposition = (disposition) => {
      observe?.(disposition);
      if (
        replyOperationRunState &&
        (disposition !== "queue-cap-old" || replyOperationRunState.admission?.status !== "accepted")
      ) {
        replyOperationRunState.admission = { status: "skipped", reason: "queue-cap" };
      }
    };
    const traceAgentPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: followupRun.run.config,
        attributes: traceAttributes,
      });
    const sourceTurnId = readChannelSourceTurnId(sessionCtx);
    const effectiveShouldSteer = !resetTriggered && shouldSteer;
    const isActiveSteer = effectiveShouldSteer && isActive;
    const messageInjectionDisposition = opts?.messageInjectionDisposition ?? "none";
    const activeReplyOperation = controllerInput.mailbox.owner.active;
    const steeringRequesterMismatch =
      isActiveSteer && hasReplySteeringRequesterMismatch(followupRun, activeReplyOperation);
    const collaborationBlocked = messageInjectionDisposition === "collaborative-steering-disabled";
    if (
      collaborationBlocked &&
      followupRun.run.config.messages?.queue?.collaborativeSteeringFallback === "reject"
    ) {
      try {
        await refuseCollaborativeSteering(followupRun, replyOperationRunState);
      } finally {
        typing.cleanup();
      }
      return undefined;
    }
    // A rejected or vanished target leaves input with the follow-up queue,
    // independently of whether the incoming requester could collaborate.
    const shouldQueueUnavailableSteer =
      isActiveSteer &&
      (collaborationBlocked ||
        messageInjectionDisposition === "rejected" ||
        (messageInjectionDisposition === "none" && !activeReplyOperation));
    const typingSignals = createTypingSignaler({
      typing,
      mode: typingMode,
    });
    // Direct question creators can attest their caller before publishing a reply operation.
    const questionInput: Awaited<ReturnType<typeof runReplyQuestionInput>> =
      steeringRequesterMismatch && activeReplyOperation
        ? { handled: false }
        : await runReplyQuestionInput(params);
    if (questionInput.handled) {
      typing.cleanup();
      return questionInput.payload;
    }

    const questionRequesterMismatch = questionInput.requesterMismatch === true;

    const toolResultOptions = {
      getVerboseLevel: () =>
        (sessionKey ? activeSessionStore?.[sessionKey]?.verboseLevel : undefined) ??
        activeSessionEntry?.verboseLevel,
      resolvedVerboseLevel,
      verboseLevelOverride: followupRun.run.verboseLevelOverride,
    };
    const shouldEmitToolResult =
      opts?.forceToolResultProgress && opts.onToolResult
        ? () => true
        : createShouldEmitToolResult(toolResultOptions);
    const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
    const touchActiveSessionEntry = () =>
      touchQueuedReplySessionActivity(
        { ...params, sessionStore: activeSessionStore },
        activeSessionEntry,
        (entry) => {
          activeSessionEntry = entry;
        },
      );

    const queuedRunFollowupTurn = createFollowupRunner({
      resolveGatewayContext,
      opts,
      typing,
      typingMode,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      sessionKey,
      storePath,
      defaultModel,
      toolProgressDetail,
    });

    if (messageInjectionDisposition === "accepted") {
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "steer" };
      }
      typing.cleanup();
      return undefined;
    }
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    // The queue must stay dormant while the active owner can still collect
    // messages. Registering after enqueue closes the owner-clear race.
    const queuedOperationOwner = replyRunRegistry.get(queueKey) ?? activeReplyOperation;
    recordGroupParticipationInput(queuedOperationOwner, followupRun);
    if (queuedOperationOwner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: queuedOperationOwner,
        queueKey,
        replyOperationRunState,
        resolvedQueue,
        sourceTurnId,
        runFollowup: queuedRunFollowupTurn,
        sessionCtx,
        sessionKey,
        sessionEntry: activeSessionEntry,
        storePath,
        touchActiveSessionEntry,
        typingSignals,
      });
      if (!controllerInput.custody.enqueued || controllerInput.custody.completed) {
        typing.cleanup();
      }
      return result === "handled" ? undefined : result;
    }

  recordGroupParticipationInput(providedReplyOperation, followupRun, "initial");
  followupRun.run.config = await resolveQueuedReplyExecutionConfig(followupRun.run.config, {
    originatingChannel: sessionCtx.OriginatingChannel,
    messageProvider: followupRun.run.messageProvider,
    originatingAccountId: followupRun.originatingAccountId,
    agentAccountId: followupRun.run.agentAccountId,
  });
  followupRun.run.agentId ??= resolveDefaultAgentId(followupRun.run.config);

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode =
    followupRun.originatingReplyToMode ??
    resolveReplyToMode(
      followupRun.run.config,
      replyToChannel,
      sessionCtx.AccountId,
      sessionCtx.ChatType,
    );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const replyMediaContext = createReplyMediaContext({
    cfg,
    agentId: followupRun.run.agentId,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
    mediaNormalizationOwner: followupRun.run.mediaNormalizationOwner,
    messageProvider: followupRun.run.messageProvider,
    accountId: followupRun.originatingAccountId ?? followupRun.run.agentAccountId,
    groupId: followupRun.run.groupId,
    groupChannel: followupRun.run.groupChannel,
    groupSpace: followupRun.run.groupSpace,
    requesterSenderId: followupRun.run.senderId,
    requesterSenderName: followupRun.run.senderName,
    requesterSenderUsername: followupRun.run.senderUsername,
    requesterSenderE164: followupRun.run.senderE164,
  });
  const compactionNoticeMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const sendDirectCompactionNotice = shouldNotifyUserAboutCompaction(cfg)
    ? async (phase: CompactionNoticePhase, text?: string) => {
        if (!opts?.onBlockReply) {
          return;
        }
        const noticePayload = createCompactionNoticePayload({
          phase,
          text,
          currentMessageId: compactionNoticeMessageId,
          applyReplyToMode,
        });
        try {
          await opts.onBlockReply(noticePayload);
        } catch (err) {
          logVerbose(`context maintenance notice delivery failed: ${String(err)}`);
        }
      }
    : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && (opts?.onPreparedBlockReply || opts?.onBlockReply)
      ? createBlockReplyPipeline({
          onBlockReply: (payload, context) => deliverPreparedBlockReply(opts, payload, context),
          timeoutMs: blockReplyTimeoutMs,
          coalescing: resolveEffectiveBlockStreamingConfig({
            cfg,
            provider: sessionCtx.Provider,
            accountId: sessionCtx.AccountId,
            chunking: blockReplyChunking,
          }).coalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const resolveVisibleReplyDelivery = async () => {
    // Settle accepted or in-flight blocks before deciding whether a terminal failure may stay silent.
    try {
      await blockReplyPipeline?.flush({ force: true });
    } catch (flushError) {
      logVerbose(
        `failed to flush streamed reply blocks before surfacing run failure: ${String(flushError)}`,
      );
    }
    return didDeliverVisiblePartialReply || blockReplyPipeline?.didStream() === true;
  };
  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  const replyRouteThreadId = resolveRoutedDeliveryThreadId({
    ctx: sessionCtx,
    sessionKey: replySessionKey,
  });
  let replyOperation: ReplyOperation;
  if (providedReplyOperation) {
    replyOperation = providedReplyOperation;
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "owned" };
    }
    releaseAdmissionTicket();
  } else {
    const replyTurnKind = resolveReplyTurnKind(opts);
    const admission = await admitReplyTurn({
      providerReviewAcknowledgment: opts?.providerReviewAcknowledgment,
      agentId: followupRun.run.agentId,
      resolveGatewayContext,
      sessionId: followupRun.run.sessionId,
      sessionKey: replySessionKey ?? "",
      expectedSessionId: activeSessionEntry?.sessionId,
      storePath,
      kind: replyTurnKind,
      resetTriggered: effectiveResetTriggered,
      routeThreadId: replyRouteThreadId,
      originatingLeafEntryId: turnAdoptionLifecycle?.originatingLeafEntryId,
      upstreamAbortSignal: resolveFollowupAbortSignal({
        abortSignal: opts?.abortSignal,
        operatorAuthority: followupRun.operatorAuthority,
      }),
    });
    if (activeRunQueueAction === "enqueue-followup") {
      bindReplyOperationQueueDisposition(followupRun, replyOperationRunState);
      const enqueued = await enqueueReplySourceAdmission({
        options: explicitFollowup ? opts : undefined,
        input: controllerInput,
        followupRun,
        runId,
        assertCurrent: () => {
          assertAgentRunLifecycleGenerationCurrent(inputGeneration);
          followupRun.operatorAuthority?.assertCurrent();
        },
        enqueue: () =>
          enqueueFollowupRun(
            queueKey,
            followupRun,
            resolvedQueue,
            "message-id",
            queuedRunFollowupTurn,
            false,
          ),
      });
      if (shouldQueueUnavailableSteer) {
        diagnosticLogger.warn("steering rejected; applying follow-up policy", {
          reason:
            messageInjectionDisposition === "rejected"
              ? (opts?.messageInjectionRejection?.reason ?? "runtime_rejected")
              : providedReplyOperation
                ? "source-operation-pending"
                : "reply-owner-ended",
          ...(opts?.messageInjectionRejection?.runtimeReason
            ? { runtimeReason: opts.messageInjectionRejection.runtimeReason }
            : {}),
          ...(opts?.messageInjectionRejection?.errorMessage
            ? { error: opts.messageInjectionRejection.errorMessage.slice(0, 512) }
            : {}),
          disposition: enqueued
            ? "followup-queued"
            : replyOperationRunState?.admission?.status === "skipped" &&
                replyOperationRunState.admission.reason === "queue-cap"
              ? "skipped-queue-cap"
              : "followup-not-enqueued",
          channel:
            followupRun.originatingChannel ??
            followupRun.run.messageProvider ??
            sessionCtx.Provider,
          sessionKey: sessionKey ?? followupRun.run.sessionKey,
          runId: opts?.runId,
        });
      }
      if (!enqueued) {
        typing.cleanup();
        return undefined;
      }
      replyRunState.recordReplyFollowupAdmission(replyOperationRunState, {
        explicitFollowup,
        requesterMismatch: questionRequesterMismatch,
        collaborationBlocked,
        unavailableSteer:
          effectiveShouldSteer && (isActive || messageInjectionDisposition === "rejected"),
        followupRun,
      });
      // The queue must stay dormant while the active owner can still collect
      // messages. Registering after enqueue closes the owner-clear race.
      const queuedOperationOwner =
        controllerInput.mailbox.owner.active ?? activeReplyOperation ?? providedReplyOperation;
      if (queuedOperationOwner) {
        scheduleFollowupDrainAfterReplyOperationClear({
          operation: queuedOperationOwner,
          queueKey,
          runFollowup: queuedRunFollowupTurn,
        });
      } else {
        scheduleFollowupDrain(queueKey, queuedRunFollowupTurn, controllerInput.mailbox.owner);
      }
      const queuedBehindActiveRun = (await isRunActive?.()) === true;
      await touchActiveSessionEntry();
      // Queued execution retains its source's controller. A group input starts
      // feedback only after its own participation assessment approves execution.
      if (queuedBehindActiveRun && !followupRun.groupParticipation) {
        await typingSignals.signalToolStart();
      }
      return undefined;
    }

    const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
    const replyRouteThreadId = resolveRoutedDeliveryThreadId({
      ctx: sessionCtx,
      sessionKey: replySessionKey,
    });
    const replyTurnKind = resolveReplyTurnKind(opts);
    const rotationEvidence = providedReplyOperation
      ? undefined
      : createReplyTurnRotationEvidence({
          sessionKey: replySessionKey ?? "",
          controller: controllerInput.mailbox.owner,
        });
    let callerOwnedReplyOperation = providedReplyOperation;
    const pendingCompactionNotices: ReplyPayload[] = [];
    let directCompactionNotice:
      | ((phase: CompactionNoticePhase, text?: string) => Promise<void>)
      | undefined;
    const preparation = await prepareReplyAgentTurn({
      queued: followupRun,
      defaults: {
        resolveGatewayContext,
        opts: runOpts,
        typing,
        typingMode,
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        defaultModel,
        toolProgressDetail,
      },
      kind: replyTurnKind,
      resetTriggered,
      routeThreadId: replyRouteThreadId,
      providedReplyOperation,
      rotationEvidence,
      claimSource: providedReplyOperation
        ? undefined
        : async () => {
            const observation = rotationEvidence?.observeAdmission();
            try {
              immediateClaim = await claimSessionControllerInput(followupRun);
              return immediateClaim;
            } catch (error) {
              if (!resolveFollowupAbortSignal(followupRun)?.aborted) {
                throw error;
              }
              return undefined;
            } finally {
              observation?.dispose();
            }
          },
      onOperationOwned: (operation) => {
        if (providedReplyOperation) {
          immediateClaim = controllerInput.claim;
        }
        if (!providedReplyOperation && opts?.onReplyOperationOwned?.(operation) === true) {
          callerOwnedReplyOperation = operation;
          return true;
        }
        return Boolean(providedReplyOperation);
      },
      configure: (cfg) => {
        const presentation = prepareReplyRunPresentation(
          params,
          cfg,
          pendingCompactionNotices,
          blockReplyTimeoutMs,
        );
        preparationResources.stopBlockReply = presentation.blockReplyPipeline?.stop;
        directCompactionNotice = presentation.sendDirectCompactionNotice;
        return presentation;
      },
      signalRunStart: typingSignals.signalRunStart,
      trace: traceAgentPhase,
      onCompactionNotice: async (phase, text) => await directCompactionNotice?.(phase, text),
    });
    if (preparation.kind === "skipped") {
      if (preparation.operation && preparation.operation !== callerOwnedReplyOperation) {
        preparation.operation.complete();
      }
      if (replyOperationRunState) {
        replyOperationRunState.admission = {
          status: "skipped",
          reason:
            preparation.reason === "goal-inactive" ? "lifecycle-invalidated" : preparation.reason,
        };
      }
      preparationResources.stopBlockReply?.();
      typing.cleanup();
      if (preparation.reason !== "active-run" || replyTurnKind !== "visible") {
        return undefined;
      }
      return markReplyPayloadForSourceSuppressionDelivery({
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      });
    }
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "owned" };
    }
    const turn = preparation.turn;
    Object.assign(followupRun, turn.queued);
    activeSessionEntry = turn.session.current();
    activeSessionStore = turn.sessionStore;
    const replyOperation = turn.operation;
    const {
      cfg,
      replyToChannel,
      replyToMode,
      returnWithQueuedFollowupDrain,
      runFollowupTurn,
      sendDirectCompactionNotice,
      setActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      setRunFollowupTurn: (runner) => {
        runFollowupTurn = runner;
      },
      shouldEmitToolOutput,
      shouldEmitToolResult,
      traceAgentPhase,
      turnAdoptionLifecycle,
      typingSignals,
    });
  } catch (error) {
    replyRunState.recordReplyOperationAgentTurn(
      followupRun.replyOperationRunStates,
      replyOperation,
    );
    if (readGroupParticipationRun(replyOperation)?.isPrivate) {
      if (!replyOperation.result) {
        replyOperation.fail("run_failed", error);
      }
      return returnWithQueuedFollowupDrain(undefined);
    }
    return await handleReplyAgentRunError(error, {
      resolveVisibleReplyDelivery,
      isHeartbeat,
      replyExpectation,
      isRestartRecoveryArmed,
      replyOperation,
      resolvedVerboseLevel,
      returnWithQueuedFollowupDrain,
      sessionCtx,
    });
  } finally {
    await cleanupReplyAgentRun({
      blockReplyPipeline,
    } = preparation.configured;
    const resolveVisibleReplyDelivery = async () => {
      // Settle accepted blocks before deciding whether a terminal failure may stay silent.
      try {
        await blockReplyPipeline?.flush({ force: true });
      } catch (flushError) {
        logVerbose(
          `failed to flush streamed reply blocks before surfacing run failure: ${String(flushError)}`,
        );
      }
      return hasVisiblePartialReply() || blockReplyPipeline?.didStream() === true;
    };
    bindReplyOperationTyping(replyOperation, typing);
    // In message-tool-only delivery, a final message-tool send is the answer while the run
    // continues. Report it now, so channel progress UI stops before it renders below it.
    const stopSourceReplyObservation = replyOperation.onSourceReplyDelivered(() => {
      if (followupRun.run.sourceReplyDeliveryMode !== "message_tool_only") {
        return;
      }
      try {
        void Promise.resolve(runOpts?.onObservedReplyDelivery?.()).catch(logObservedDeliveryError);
      } catch (error) {
        logObservedDeliveryError(error);
      }
    });
    let runFollowupTurn = queuedRunFollowupTurn;
    let shouldDrainQueuedFollowupsAfterClear = false;
    const returnWithQueuedFollowupDrain = <T>(value: T): T => {
      shouldDrainQueuedFollowupsAfterClear = true;
      return value;
    };
    if (replyOperationRunState && isRequiredReplyExpectation(replyExpectation)) {
      // Dispatch owns the stall notice; this owner holds the queue facts needed to answer
      // instead. The same sender's next queued request inherits the guidance; otherwise one
      // recovery run bound to this turn's route and authority is queued.
      replyOperationRunState.continueStalledTurn = (guidance, owner = replyOperation) =>
        owner === replyOperation &&
        continueStalledReplyTurn({
          followupRun,
          queueKey,
          resolvedQueue,
          replyOperation,
          runFollowupTurn,
          guidance,
        });
    }
    const { admitUserTurn, completeUnexecutedTurn, recordPendingDelivery } =
      createReplyInputAdmission({
        followupRun,
        replyOperation,
        runId: turn.runId,
        sourceTurnId,
        sessionKey,
        storePath,
        setEntry: (entry) => {
          activeSessionEntry = entry;
          if (activeSessionStore && sessionKey) {
            activeSessionStore[sessionKey] = entry;
          }
        },
      });
    try {
      // Channel admission rethrows its memoized preflight failure in the execution handler.
      if (turn.preflightError && !isChannelRunAuthorizationError(turn.preflightError)) {
        throw turn.preflightError;
      }
      const executePrepared = () =>
        executePreparedReplyAgentRun({
          ...params,
          activeSessionStore,
          admitUserTurn,
          completeUnexecutedTurn,
          recordPendingDelivery,
          applyReplyToMode,
          blockReplyPipeline,
          cfg,
          resolveVisibleReplyDelivery,
          activeIsNewSession: isNewSession,
          getActiveSessionEntry: turn.session.current,
          opts: runOpts,
          onCompactionNoticePayload: (payload) => {
            pendingCompactionNotices.push(payload);
          },
          pendingToolTasks: new Set<Promise<void>>(),
          replyMediaContext,
          replyOperation,
          replyRouteThreadId,
          replyToChannel,
          replyToMode,
          returnWithQueuedFollowupDrain,
          runFollowupTurn,
          admittedTurn: turn,
          setRunFollowupTurn: (runner) => {
            runFollowupTurn = runner;
          },
          shouldEmitToolOutput: createShouldEmitToolOutput(toolResultOptions),
          shouldEmitToolResult,
          traceAgentPhase,
          typingSignals,
        });
      // Direct callers also need the admitted owner during nested runtime admission.
      const result = await runWithReplyOperationLifecycleAdmission(replyOperation, executePrepared);
      return prependCompactionNotices(result, pendingCompactionNotices, replyOperation);
    } catch (error) {
      replyRunState.recordReplyOperationAgentTurn(
        followupRun.replyOperationRunStates,
        replyOperation,
      );
      if (
        turn.preflightFailurePayload &&
        (!replyOperation.abortSignal.aborted ||
          (followupRun.operatorAuthority?.signal?.aborted &&
            replyOperation.abortSignal.reason === followupRun.operatorAuthority.signal.reason &&
            !isUserInitiatedAgentRunAbortReason(replyOperation.abortSignal.reason) &&
            resolveReplyOperationAbortReason(replyOperation) === "user"))
      ) {
        // The prepared failure notice survives source revocation; it starts no new work.
        replyOperation.fail("run_failed", error);
        return prependCompactionNotices(
          returnWithQueuedFollowupDrain(turn.preflightFailurePayload),
          pendingCompactionNotices,
          replyOperation,
        );
      }
      const result = await handleReplyAgentRunError(error, {
        config: cfg,
        resolveVisibleReplyDelivery,
        userTurnAccepted: followupRun.userTurnTranscriptRecorder?.hasPersisted() === true,
        replyExpectation,
        replyOperation,
        resolvedVerboseLevel,
        returnWithQueuedFollowupDrain,
        sessionCtx,
      });
      return prependCompactionNotices(result, pendingCompactionNotices, replyOperation);
    } finally {
      stopSourceReplyObservation();
      try {
        await cleanupReplyAgentRun({
          blockReplyPipeline,
          releaseSourceAdmission: turn.releaseSourceAdmission,
          providedReplyOperation: callerOwnedReplyOperation,
          queueKey,
          replyOperation,
          runFollowupTurn,
          sessionKey,
          shouldDrainQueuedFollowupsAfterClear,
          typing,
        });
      } finally {
        completeFollowupRunLifecycle(followupRun);
      }
    }
  } catch (error) {
    preparationResources.stopBlockReply?.();
    typing.cleanup();
    throw error;
  } finally {
    // A queued fallback may already own this source by the time ingress returns.
    if (immediateClaim) {
      releaseSessionControllerClaim(immediateClaim);
    }
    retireUnadoptedReplySource(controllerInput);
  }
}

function logObservedDeliveryError(error: unknown): void {
  logVerbose(`observed reply delivery callback failed: ${String(error)}`);
}
