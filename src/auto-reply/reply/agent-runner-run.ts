import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { hasRestartRecoverySourceClaim } from "../../config/sessions/restart-recovery-state.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
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
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
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
  createReplyAgentRestartRecoveryController,
  executePreparedReplyAgentRun,
} from "./agent-runner-execute.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  isAudioPayload,
} from "./agent-runner-helpers.js";
import { deliverPreparedBlockReply } from "./agent-runner-presentation.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { buildReplyMediaContextParams } from "./agent-runner-run-params.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { resolveQueuedReplyExecutionConfig } from "./agent-runner-utils.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import {
  type CompactionNoticePhase,
  createCompactionNoticePayload,
  shouldNotifyUserAboutCompaction,
} from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { REPLY_ADMISSION_TICKET } from "./reply-admission-ticket.js";
import { createReplyMediaContext } from "./reply-media-paths.js";
import * as replyRunState from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import {
  captureReplyOperationSessionReader,
  getReplyOperationSessionReader,
} from "./reply-run-registry.state.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";
import {
  isDuplicateRestartRecoverySource,
  retireTerminalRestartRecoverySourceClaim,
} from "./restart-recovery-claim.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
import { createTypingSignaler } from "./typing-mode.js";
export async function runReplyAgent(
  input: RunReplyAgentParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const params = { ...input };
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
    sessionStore: activeSessionStore,
    sessionKey,
    runtimePolicySessionKey,
    storePath,
    defaultModel,
    resolvedVerboseLevel,
    toolProgressDetail,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    sessionCtx,
    typingMode,
    resetTriggered,
    replyOperation: providedReplyOperation,
  } = params;
  followupRun.operatorAuthority?.assertCurrent();
  const resolveGatewayContext = providedReplyOperation
    ? getGatewayContextResolver(providedReplyOperation)
    : (readChannelContextGatewayContextResolver(sessionCtx) ??
      getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
  // One lifecycle for all adoption sites in this run.
  const turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
  const releaseAdmissionTicket = () => opts?.[REPLY_ADMISSION_TICKET]?.release();
  const releaseUnusedAdmission = () => {
    releaseAdmissionTicket();
    typing.cleanup();
  };
  let activeSessionEntry = sessionEntry;
  const effectiveResetTriggered = resetTriggered === true;

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
  let didDeliverVisiblePartialReply = false;
  const onPartialReply = opts?.onPartialReply;
  const runOpts = {
    ...opts,
    runId: opts?.runId ?? randomUUID(),
    ...(onPartialReply
      ? {
          onPartialReply: async (
            payload: Parameters<NonNullable<typeof opts.onPartialReply>>[0],
          ) => {
            const observed = await settleProgressVisibilityCallbackResult(onPartialReply(payload));
            if (observed.visible && hasOutboundReplyContent(payload, { trimText: true })) {
              didDeliverVisiblePartialReply = true;
            }
            return observed.result;
          },
        }
      : {}),
  };
  const replyOperationRunState = replyRunState.resolveReplyOperationRunState(opts);
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
  let restartRecoveryEntry: typeof activeSessionEntry;
  let restartRecoveryTarget: SessionEntryTargetPatchScope | undefined;
  try {
    restartRecoveryEntry =
      sessionKey && storePath
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
  } catch (error) {
    releaseUnusedAdmission();
    throw error;
  }
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
        releaseUnusedAdmission();
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
    releaseUnusedAdmission();
    return undefined;
  }

  const effectiveShouldSteer = !isHeartbeat && !effectiveResetTriggered && shouldSteer;
  const effectiveShouldFollowup = !effectiveResetTriggered && shouldFollowup;
  const messageInjectionDisposition = opts?.messageInjectionDisposition ?? "none";
  const activeReplyOperation = sessionKey
    ? replyRunRegistry.get(sessionKey)
    : providedReplyOperation;
  // A source-only reservation still owns completion, but is not a steering target.
  const shouldQueueProvidedSteer =
    effectiveShouldSteer &&
    isActive &&
    messageInjectionDisposition === "none" &&
    !activeReplyOperation &&
    Boolean(providedReplyOperation);
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });
  // New steering must not reuse a terminal source claim. Compare the active
  // source identity so unrelated retained tombstones still permit steering.
  // The parked admission owner rechecks after any predecessor wait.
  const activeSourceTurnId =
    replyRunRegistry.getSourceTurnId(sessionKey ?? "") ??
    normalizeOptionalString(restartRecoveryEntry?.restartRecoveryDeliverySourceRunId) ??
    "";
  const terminalDeliveryBlockReason = resolveRestartRecoverySteeringBlockReason(
    restartRecoveryEntry,
    activeReplyOperation?.sessionId ?? followupRun.run.sessionId,
    activeSourceTurnId,
  );
  const shouldQueueTerminalReceiptSteer =
    effectiveShouldSteer &&
    isActive &&
    messageInjectionDisposition === "none" &&
    terminalDeliveryBlockReason !== undefined;

  const questionInput = await runReplyQuestionInput(input);
  if (questionInput.handled) {
    releaseUnusedAdmission();
    return questionInput.payload;
  }

  const toolResultOptions = {
    sessionKey,
    storePath,
    resolvedVerboseLevel,
    verboseLevelOverride: followupRun.run.verboseLevelOverride,
  };
  const baseShouldEmitToolResult = createShouldEmitToolResult(toolResultOptions);
  const channelProgressCanConsumeToolResults =
    Boolean(opts?.forceToolResultProgress) && Boolean(opts?.onToolResult);
  const shouldEmitToolResult = () =>
    channelProgressCanConsumeToolResults || baseShouldEmitToolResult();
  const shouldEmitToolOutput = createShouldEmitToolOutput(toolResultOptions);

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
  const touchActiveSessionEntry = async () => {
    if (opts?.internalEventExecution || !activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    // Keep the in-memory snapshot aligned with the pending-reset write boundary.
    const updatedAt = activeSessionEntry.updatedAt === 0 ? 0 : Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionEntry(
        { agentId: followupRun.run.agentId, storePath, sessionKey },
        () => ({ updatedAt }),
        { skipMaintenance: true, takeCacheOwnership: true },
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
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "steer" };
    }
    releaseUnusedAdmission();
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
  };

  if (
    effectiveShouldSteer &&
    isActive &&
    !shouldQueueProvidedSteer &&
    !shouldQueueTerminalReceiptSteer &&
    messageInjectionDisposition === "none"
  ) {
    bindQueueDisposition();
    const result = await runActiveReplySteer({
      followupRun,
      opts,
      providedReplyOperation: activeReplyOperation,
      queueKey,
      releaseAdmissionTicket,
      replyOperationRunState,
      resolvedQueue,
      restartRecoverySourceTurnId,
      runFollowup: queuedRunFollowupTurn,
      sessionCtx,
      sessionKey,
      sessionEntry: activeSessionEntry,
      storePath,
      touchActiveSessionEntry,
      typing,
      typingSignals,
    });
    return result === "handled" ? undefined : result;
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    hasQueuedFollowups,
    isActive,
    isHeartbeat,
    shouldFollowup: effectiveShouldFollowup || shouldQueueProvidedSteer,
    resetTriggered: effectiveResetTriggered,
  });
  if (activeRunQueueAction === "drop") {
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "skipped", reason: "active-run" };
    }
    releaseUnusedAdmission();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    bindQueueDisposition();
    const enqueued = enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    if (shouldQueueTerminalReceiptSteer || shouldQueueProvidedSteer) {
      diagnosticLogger.warn("steering rejected; applying follow-up policy", {
        reason: shouldQueueTerminalReceiptSteer
          ? terminalDeliveryBlockReason
          : "source-operation-pending",
        disposition: enqueued
          ? "followup-queued"
          : replyOperationRunState?.admission?.status === "skipped" &&
              replyOperationRunState.admission.reason === "queue-cap"
            ? "skipped-queue-cap"
            : "followup-not-enqueued",
        channel:
          followupRun.originatingChannel ?? followupRun.run.messageProvider ?? sessionCtx.Provider,
        sessionId: activeReplyOperation?.sessionId ?? followupRun.run.sessionId,
        runId: opts?.runId,
      });
    }
    if (!enqueued) {
      releaseUnusedAdmission();
      return undefined;
    }
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    // The queue must stay dormant while the active owner can still collect
    // messages. Registering after enqueue closes the owner-clear race.
    const queuedOperationOwner =
      replyRunRegistry.get(queueKey) ?? activeReplyOperation ?? providedReplyOperation;
    if (queuedOperationOwner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: queuedOperationOwner,
        queueKey,
        runFollowup: queuedRunFollowupTurn,
      });
    } else {
      scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
    }
    releaseAdmissionTicket();
    const queuedBehindActiveRun = isRunActive?.() === true;
    await touchActiveSessionEntry();
    if (queuedBehindActiveRun) {
      await typingSignals.signalToolStart();
    } else {
      typing.cleanup();
    }
    return undefined;
  }

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
  const replyMediaContext = createReplyMediaContext(
    buildReplyMediaContextParams(followupRun, sessionKey, cfg),
  );
  const compactionNoticeMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const sendDirectCompactionNotice = async (phase: CompactionNoticePhase, text?: string) => {
    if (
      !opts?.onBlockReply ||
      (phase !== "context_bounded" && !shouldNotifyUserAboutCompaction(cfg))
    ) {
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
  };
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
          isAudioPayload,
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
  let callerOwnedReplyOperation = providedReplyOperation;
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
    if (replyOperationRunState) {
      replyOperationRunState.admission =
        admission.status === "owned"
          ? { status: "owned" }
          : { status: "skipped", reason: admission.reason };
    }
    if (admission.status === "skipped") {
      releaseUnusedAdmission();
      if (admission.reason !== "active-run" || replyTurnKind !== "visible") {
        return undefined;
      }
      return markReplyPayloadForSourceSuppressionDelivery({
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      });
    }
    replyOperation = admission.operation;
    releaseAdmissionTicket();
    const previousRunSessionId = followupRun.run.sessionId;
    followupRun.run.sessionId = replyOperation.sessionId;
    if (replyOperation.sessionId !== previousRunSessionId) {
      const admittedSessionEntry =
        admission.sessionEntry ??
        (replySessionKey
          ? (activeSessionStore?.[replySessionKey] ?? activeSessionEntry)
          : activeSessionEntry);
      if (admittedSessionEntry?.sessionId === replyOperation.sessionId) {
        activeSessionEntry = admittedSessionEntry;
        if (admission.sessionEntry && activeSessionStore && replySessionKey) {
          activeSessionStore[replySessionKey] = admission.sessionEntry;
        }
        const admittedSessionFile = normalizeOptionalString(replySessionKey);
        if (admittedSessionFile) {
          followupRun.run.sessionFile = admittedSessionFile;
        }
      }
    }
  }
  bindReplyOperationTyping(replyOperation, typing);
  let runFollowupTurn = queuedRunFollowupTurn;
  let shouldDrainQueuedFollowupsAfterClear = false;
  const returnWithQueuedFollowupDrain = <T>(value: T): T => {
    shouldDrainQueuedFollowupsAfterClear = true;
    return value;
  };
  if (replyOperationRunState && !isHeartbeat && replyExpectation === "required") {
    // Dispatch owns the stall notice; this owner holds the queue facts needed to answer
    // instead. The same sender's next queued request inherits the guidance; otherwise one
    // recovery run bound to this turn's route and authority is queued.
    replyOperationRunState.continueStalledTurn = () =>
      continueStalledReplyTurn({
        followupRun,
        queueKey,
        resolvedQueue,
        replyOperation,
        runFollowupTurn,
      });
  }
  const {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
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
    if (!providedReplyOperation && opts?.onReplyOperationOwned?.(replyOperation) === true) {
      callerOwnedReplyOperation = replyOperation;
    }
    await replyOperation.bindToolAuthoritySnapshotAsync(
      prepareReplyToolAuthority(
        followupRun,
        undefined,
        captureReplyOperationSessionReader(replyOperation),
      ),
    );
    return await executePreparedReplyAgentRun({
      ...params,
      activeSessionStore,
      admitUserTurn,
      applyReplyToMode,
      beginBeforeAgentReply,
      blockReplyPipeline,
      cfg,
      checkpointBeforeAgentReply,
      resolveVisibleReplyDelivery,
      activeIsNewSession: isNewSession,
      getActiveSessionEntry: () => activeSessionEntry,
      isHeartbeat,
      isRestartRecoveryArmed,
      opts: runOpts,
      pendingToolTasks,
      replyMediaContext,
      replyOperation,
      replyRouteThreadId,
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
      clearRestartRecoveryDeliveryClaim,
      isHeartbeat,
      providedReplyOperation: callerOwnedReplyOperation,
      queueKey,
      replyOperation,
      runFollowupTurn,
      sessionKey,
      shouldDrainQueuedFollowupsAfterClear,
      typing,
    });
  }
}
