import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import {
  isRequiredReplyExpectation,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { hasRestartRecoverySourceClaim } from "../../config/sessions/restart-recovery-state.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
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
  tryClaimSessionControllerTask,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  captureReplyOperationSessionReader,
  getReplyOperationSessionReader,
} from "../../sessions/session-controller.session-reader.js";
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
import { hasReplySteeringRequesterMismatch } from "./agent-runner-fallback-authority.js";
import { createShouldEmitToolOutput, createShouldEmitToolResult } from "./agent-runner-helpers.js";
import {
  prepareReplyRunOptions,
  prepareReplyRunPresentation,
} from "./agent-runner-presentation.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { createReplyAgentRestartRecoveryController } from "./agent-runner-restart-recovery.js";
import { touchQueuedReplySessionActivity } from "./agent-runner-session-activity.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "./queue.js";
import { refuseCollaborativeSteering } from "./queue/lifecycle.js";
import { bindReplyOperationQueueDisposition, resolveFollowupAbortSignal } from "./queue/types.js";
import { prepareReplyAgentTurn } from "./reply-agent-turn-preparation.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { bindReplySourceToFollowup, retireUnadoptedReplySource } from "./reply-source-binding.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission-lifecycle.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";
import {
  isDuplicateRestartRecoverySource,
  retireTerminalRestartRecoverySourceClaim,
} from "./restart-recovery-source.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { readChannelSourceTurnId, resolveReplyAdmissionRunId } from "./source-turn-id.js";
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
    runtimePolicySessionKey,
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
  try {
    followupRun.operatorAuthority?.assertCurrent();
    const resolveGatewayContext = providedReplyOperation
      ? getGatewayContextResolver(providedReplyOperation)
      : (readChannelContextGatewayContextResolver(sessionCtx) ??
        getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
    let activeSessionEntry = sessionEntry;
    let activeSessionStore = sessionStore;

    const isHeartbeat = opts?.isHeartbeat === true;
    const replyExpectation = (followupRun.run.terminalReplyExpectation ??=
      resolveSourceReplyExpectation({
        ctx: {
          ...sessionCtx,
          InboundEventKind: followupRun.currentInboundEventKind ?? sessionCtx.InboundEventKind,
          InputProvenance: followupRun.run.inputProvenance ?? sessionCtx.InputProvenance,
        },
        cfg: followupRun.run.config,
        isHeartbeat,
      }));
    const explicitFollowup = isExplicitFollowupCommandTurn(sessionCtx);
    if (explicitFollowup) {
      followupRun.disableCollectBatching = true;
    }
    const replyOperationRunState = replyRunState.resolveReplyOperationRunState(opts);
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
    if (replyOperationRunState && !isHeartbeat && isRequiredReplyExpectation(replyExpectation)) {
      // Preparation has not transferred the accepted input into an executable turn yet.
      replyOperationRunState.continueStalledTurn = () => false;
    }
    if (replyOperationRunState) {
      replyOperationRunState.replyCompletion = resolveReplyCompletion(
        followupRun.run.terminalReplyExpectation,
        "empty",
      );
    }
    followupRun.replyOperationRunStates = replyOperationRunState
      ? [replyOperationRunState]
      : undefined;
    const traceAttributes = {
      provider: followupRun.run.provider,
      hasSessionKey: Boolean(sessionKey ?? followupRun.run.sessionKey),
      isHeartbeat,
      queueMode: resolvedQueue.mode,
      isActive,
      blockStreamingEnabled,
    };
    const traceAgentPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: followupRun.run.config,
        attributes: traceAttributes,
      });
    const readGeneration = getAgentEventLifecycleGeneration();
    const assertReadCurrent = composeSessionSourceAssertion(
      [followupRun.operatorAuthority?.assertCurrent],
      (assertSource) => {
        assertAgentRunLifecycleGenerationCurrent(readGeneration);
        assertSource();
      },
    );
    const restartRecoverySourceTurnId = readChannelSourceTurnId(sessionCtx);
    let restartRecoveryTarget: SessionEntryTargetPatchScope | undefined;
    const restartRecoveryEntry =
      sessionKey && storePath && (restartRecoverySourceTurnId || (shouldSteer && isActive))
        ? ((await readSessionEntryInWorker(
            { agentId: followupRun.run.agentId, storePath, sessionKey },
            assertReadCurrent,
            undefined,
            (target) => {
              restartRecoveryTarget = target;
            },
            getReplyOperationSessionReader(providedReplyOperation),
          )) ?? activeSessionEntry)
        : activeSessionEntry;
    assertReadCurrent();
    if (
      restartRecoverySourceTurnId &&
      isDuplicateRestartRecoverySource(restartRecoveryEntry, restartRecoverySourceTurnId)
    ) {
      // Durable source ownership identifies provider redelivery even if the run
      // became terminal before its claim cleanup committed.
      if (
        sessionKey &&
        storePath &&
        hasRestartRecoverySourceClaim(restartRecoveryEntry, restartRecoverySourceTurnId)
      ) {
        if (!restartRecoveryTarget) {
          throw new Error("Restart recovery retirement has no admitted session target");
        }
        const retired = await retireTerminalRestartRecoverySourceClaim({
          target: restartRecoveryTarget,
          assertCurrent: assertReadCurrent,
          sessionId: restartRecoveryEntry.sessionId,
          sourceTurnId: restartRecoverySourceTurnId,
        });
        if (retired) {
          activeSessionEntry = retired;
          if (activeSessionStore) {
            activeSessionStore[sessionKey] = retired;
          }
        }
      }
      typing.cleanup();
      return undefined;
    }

    const effectiveShouldSteer = !isHeartbeat && !resetTriggered && shouldSteer;
    const isActiveSteer = effectiveShouldSteer && isActive;
    const messageInjectionDisposition = opts?.messageInjectionDisposition ?? "none";
    const activeReplyOperation = controllerInput.mailbox.owner.active;
    const steeringRequesterMismatch =
      isActiveSteer && hasReplySteeringRequesterMismatch(followupRun, activeReplyOperation);
    if (messageInjectionDisposition === "collaborative-steering-disabled") {
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
      (messageInjectionDisposition === "rejected" ||
        (messageInjectionDisposition === "none" && !activeReplyOperation));
    const typingSignals = createTypingSignaler({
      typing,
      mode: typingMode,
      isHeartbeat,
    });
    // New steering must not reuse a terminal source claim. Compare the active
    // source identity so unrelated retained tombstones still permit steering.
    // The parked admission owner rechecks after any predecessor wait.
    const activeSourceTurnId =
      controllerInput.mailbox.owner.sourceTurnId ??
      normalizeOptionalString(restartRecoveryEntry?.restartRecoveryDeliverySourceRunId) ??
      "";
    const terminalDeliveryBlockReason = resolveRestartRecoverySteeringBlockReason(
      restartRecoveryEntry,
      activeReplyOperation?.sessionId ?? followupRun.run.sessionId,
      activeSourceTurnId,
    );
    const shouldQueueTerminalReceiptSteer =
      isActiveSteer &&
      messageInjectionDisposition === "none" &&
      terminalDeliveryBlockReason !== undefined;

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

    if (
      isActiveSteer &&
      !shouldQueueUnavailableSteer &&
      !questionRequesterMismatch &&
      !shouldQueueTerminalReceiptSteer &&
      messageInjectionDisposition === "none"
    ) {
      bindReplyOperationQueueDisposition(followupRun, replyOperationRunState);
      const result = await runActiveReplySteer({
        followupRun,
        opts,
        providedReplyOperation: activeReplyOperation,
        queueKey,
        replyOperationRunState,
        resolvedQueue,
        restartRecoverySourceTurnId,
        runFollowup: queuedRunFollowupTurn,
        sessionCtx,
        sessionKey,
        sessionEntry: activeSessionEntry,
        storePath,
        touchActiveSessionEntry,
        typingSignals,
      });
      typing.cleanup();
      return result === "handled" ? undefined : result;
    }

    const activeRunQueueAction = resolveActiveRunQueueAction({
      hasQueuedFollowups,
      interrupt: resolvedQueue.mode === "interrupt",
      isActive: isActive || questionRequesterMismatch,
      isHeartbeat,
      shouldFollowup: shouldFollowup || shouldQueueUnavailableSteer || questionRequesterMismatch,
      resetTriggered,
    });
    if (activeRunQueueAction === "drop") {
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "skipped", reason: "active-run" };
      }
      typing.cleanup();
      return undefined;
    }

    if (activeRunQueueAction === "enqueue-followup") {
      bindReplyOperationQueueDisposition(followupRun, replyOperationRunState);
      const enqueued = enqueueFollowupRun(
        queueKey,
        followupRun,
        resolvedQueue,
        "message-id",
        queuedRunFollowupTurn,
        false,
      );
      if (shouldQueueTerminalReceiptSteer || shouldQueueUnavailableSteer) {
        diagnosticLogger.warn("steering rejected; applying follow-up policy", {
          reason: shouldQueueTerminalReceiptSteer
            ? terminalDeliveryBlockReason
            : messageInjectionDisposition === "rejected"
              ? "runtime_rejected"
              : providedReplyOperation
                ? "source-operation-pending"
                : "reply-owner-ended",
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
          sessionId: activeReplyOperation?.sessionId ?? followupRun.run.sessionId,
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
      if (queuedBehindActiveRun) {
        await typingSignals.signalToolStart();
      } else {
        typing.cleanup();
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
      recoveryAdmissionRunId: resolveReplyAdmissionRunId(sessionCtx),
      resetTriggered,
      routeThreadId: replyRouteThreadId,
      providedReplyOperation,
      rotationEvidence,
      claimSource: providedReplyOperation
        ? undefined
        : async () => {
            const observation = rotationEvidence?.observeAdmission();
            try {
              immediateClaim = await (isHeartbeat
                ? tryClaimSessionControllerTask(controllerInput, "heartbeat")
                : claimSessionControllerInput(followupRun));
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
      applyReplyToMode,
      replyMediaContext,
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
    let runFollowupTurn = queuedRunFollowupTurn;
    let shouldDrainQueuedFollowupsAfterClear = false;
    const returnWithQueuedFollowupDrain = <T>(value: T): T => {
      shouldDrainQueuedFollowupsAfterClear = true;
      return value;
    };
    if (replyOperationRunState && !isHeartbeat && isRequiredReplyExpectation(replyExpectation)) {
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
    const {
      admitUserTurn,
      beginBeforeAgentReply,
      checkpointBeforeAgentReply,
      clear: clearRestartRecoveryDeliveryClaim,
      prepareCompletionCleanup: prepareRestartClaimCleanup,
      isArmed: isRestartRecoveryArmed,
    } = createReplyAgentRestartRecoveryController({
      activeSessionStore,
      cfg,
      followupRun,
      getActiveSessionEntry: () => activeSessionEntry,
      opts: runOpts,
      replyOperation,
      restartRecoverySourceTurnId,
      runtimePolicySessionKey,
      sessionCtx,
      sessionKey,
      setActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      storePath,
    });
    try {
      if (turn.preflightError) {
        throw turn.preflightError;
      }
      await replyOperation.bindToolAuthoritySnapshotAsync(
        prepareReplyToolAuthority(
          followupRun,
          undefined,
          captureReplyOperationSessionReader(replyOperation),
        ),
      );
      const executePrepared = () =>
        executePreparedReplyAgentRun({
          ...params,
          activeSessionStore,
          admitUserTurn,
          applyReplyToMode,
          beginBeforeAgentReply,
          blockReplyPipeline,
          cfg,
          checkpointBeforeAgentReply,
          prepareRestartClaimCleanup,
          resolveVisibleReplyDelivery,
          activeIsNewSession: isNewSession,
          getActiveSessionEntry: () => activeSessionEntry,
          isHeartbeat,
          isRestartRecoveryArmed,
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
          preflightCompactionApplied: turn.preflightCompactionApplied,
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
      const result = await handleReplyAgentRunError(error, {
        resolveVisibleReplyDelivery,
        userTurnAccepted: followupRun.userTurnTranscriptRecorder?.hasPersisted() === true,
        isHeartbeat,
        replyExpectation,
        isRestartRecoveryArmed,
        replyOperation,
        resolvedVerboseLevel,
        returnWithQueuedFollowupDrain,
        sessionCtx,
      });
      return prependCompactionNotices(result, pendingCompactionNotices, replyOperation);
    } finally {
      try {
        await cleanupReplyAgentRun({
          blockReplyPipeline,
          clearRestartRecoveryDeliveryClaim,
          releaseSourceAdmission: turn.releaseSourceAdmission,
          isHeartbeat,
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
