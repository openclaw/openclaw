import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../../agents/harness/tool-authority-preparation.js";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import type {
  ReplyMessageInjectionOutcome,
  ReplyMessageInjectionRejectionReason,
} from "../../sessions/session-controller.contracts.js";
import { captureReplyExecutionSelection } from "../../sessions/session-controller.execution-selection.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import { canInjectReplyMessageTarget } from "../../sessions/session-controller.message-injection.js";
import {
  hasReplySteeringRequesterMismatch,
  prepareReplyMessageJoin,
} from "../../sessions/session-controller.message-join.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
  waitForReplyOperationBackend,
} from "../../sessions/session-controller.state.js";
import { isExplicitCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import {
  admitFollowupRunLifecycle,
  reserveSteerCandidate,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { refuseCollaborativeSteering } from "./queue/lifecycle.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { prepareSteeringDelivery } from "./steering-delivery-preparation.js";
import type { TypingSignaler } from "./typing-mode.js";

type ActiveReplySteerFallbackReason =
  | ReplyMessageInjectionRejectionReason
  | "requester-mismatch"
  | "admission-changed"
  | "reply-owner-ended"
  | "model-fallback-changed"
  | "execution-settings-changed";

type ActiveReplySteerParams = {
  steeringIntent?: RunReplyAgentParams["steeringIntent"];
  followupRun: RunReplyAgentParams["followupRun"];
  opts: RunReplyAgentParams["opts"];
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  replyOperationRunState: ReplyOperationRunState | undefined;
  resolvedQueue: RunReplyAgentParams["resolvedQueue"];
  restartRecoverySourceTurnId: string | undefined;
  runFollowup: (run: FollowupRun) => Promise<void>;
  sessionCtx: RunReplyAgentParams["sessionCtx"];
  sessionKey: string | undefined;
  sessionEntry?: RunReplyAgentParams["sessionEntry"];
  storePath?: string;
  touchActiveSessionEntry: () => Promise<void>;
  typingSignals: TypingSignaler;
};

function resolveAcceptedSteerRunId(params: ActiveReplySteerParams): string {
  const { followupRun, sessionCtx } = params;
  return expectDefined(
    params.restartRecoverySourceTurnId ??
      buildChannelSourceTurnId({
        provider:
          followupRun.originatingChannel ?? followupRun.run.messageProvider ?? sessionCtx.Provider,
        accountId:
          followupRun.originatingAccountId ??
          followupRun.run.agentAccountId ??
          sessionCtx.AccountId,
        conversationId:
          followupRun.originatingTo ??
          followupRun.originatingChatId ??
          params.sessionKey ??
          followupRun.run.sessionKey,
        messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      }) ??
      normalizeOptionalString(params.opts?.runId),
    "steered turn id",
  );
}

export async function runActiveReplySteer(
  params: ActiveReplySteerParams,
): Promise<"handled" | ReplyPayload> {
  const {
    followupRun,
    queueKey,
    replyOperationRunState,
    resolvedQueue,
    runFollowup,
    sessionKey,
    touchActiveSessionEntry,
    typingSignals,
  } = params;
  const isInboundUserMessage =
    followupRun.currentInboundEventKind !== "room_event" &&
    (!followupRun.run.inputProvenance || followupRun.run.inputProvenance.kind === "external_user");
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const activeReplyOperation = params.providedReplyOperation;
  const activeReplyKey = activeReplyOperation?.key;
  const activeController = activeReplyOperation
    ? getSessionControllerEntryForOperation(activeReplyOperation)
    : undefined;
  // Keep an attached backend fixed across admission; startup has no backend yet.
  const backendAtArrival = activeController?.attachment?.backend;
  let injectionTarget = captureReplyMessageInjectionTarget(activeReplyOperation);
  const isCurrentOwner = () =>
    activeReplyOperation !== undefined &&
    activeReplyOperation.key === activeReplyKey &&
    isCurrentSessionControllerOperation(activeReplyOperation) &&
    getSessionControllerEntryForOperation(activeReplyOperation) === activeController &&
    (!followupRun.controllerInput ||
      followupRun.controllerInput.mailbox.owner === activeController);
  const assertReadCurrent = () => {
    resolveFollowupAbortSignal(followupRun)?.throwIfAborted();
    params.opts?.abortSignal?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
  };
  let delivery: ReturnType<typeof prepareSteeringDelivery> | undefined;
  let releaseToolAuthority: (() => void) | undefined;
  let steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
  const parked = reserveSteerCandidate(queueKey, followupRun, resolvedQueue, runFollowup);
  if (!parked) {
    return "handled";
  }
  const mailbox = expectDefined(followupRun.controllerInput, "Parked steer source").mailbox;
  const owner = mailbox.owner.active;
  if (owner) {
    scheduleFollowupDrainAfterReplyOperationClear({
      operation: owner,
      queueKey,
      runFollowup,
    });
  } else {
    scheduleFollowupDrain(queueKey, runFollowup, mailbox.owner);
  }
  let custodyFinished = false;
  const fallback = async (
    reason: ActiveReplySteerFallbackReason,
    activeRunId?: string,
    error?: string,
  ): Promise<"handled"> => {
    assertReadCurrent();
    parked.fallback();
    custodyFinished = true;
    const queueCapRejected =
      replyOperationRunState?.admission?.status === "skipped" &&
      replyOperationRunState.admission.reason === "queue-cap";
    if (replyOperationRunState && !queueCapRejected) {
      replyOperationRunState.admission = {
        status: "accepted",
        mode: "followup",
        ...(reason === "requester-mismatch"
          ? { reason }
          : isInboundUserMessage
            ? { reason: "steering-unavailable" as const }
            : {}),
      };
    }
    diagnosticLogger.warn("steering rejected; applying follow-up policy", {
      reason,
      ...(error ? { error } : {}),
      disposition: queueCapRejected ? "skipped-queue-cap" : "followup-policy",
      channel:
        followupRun.originatingChannel ??
        followupRun.run.messageProvider ??
        params.sessionCtx.Provider,
      sessionId: steerSessionId,
      runId: params.opts?.runId,
      activeRunId,
    });
    await touchActiveSessionEntry();
    return "handled";
  };
  // The native receipt owns settlement after handoff, even if a finalizer fails.
  let nativeOutcome: Promise<ReplyMessageInjectionOutcome> | undefined;
  let replayForbidden = false;
  try {
    assertReadCurrent();
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      custodyFinished = true;
      return "handled";
    }
    if (admission === "fallback") {
      return await fallback("admission-changed");
    }
    if (params.steeringIntent?.kind === "new-execution") {
      return await fallback("execution-settings-changed");
    }
    if (
      !activeReplyOperation ||
      !isCurrentOwner() ||
      !(await waitForReplyOperationBackend(
        activeReplyOperation,
        resolveFollowupAbortSignal(followupRun),
      )) ||
      !isCurrentOwner()
    ) {
      return await fallback("reply-owner-ended");
    }
    steerSessionId = activeReplyOperation.sessionId;
    if (!backendAtArrival) {
      // The exact operation survived startup; capture its first available backend
      // before policy preparation can yield or replace that attachment.
      injectionTarget = captureReplyMessageInjectionTarget(activeReplyOperation);
    }
    if (!injectionTarget) {
      return await fallback("injection_unavailable");
    }
    assertReadCurrent();
    if (
      isInboundUserMessage &&
      followupRun.run.config.messages?.queue?.allowCollaborativeSteering !== true &&
      hasReplySteeringRequesterMismatch(followupRun, activeReplyOperation)
    ) {
      if (!canInjectReplyMessageTarget(injectionTarget)) {
        return await fallback("injection_unavailable", injectionTarget.runId);
      }
      await refuseCollaborativeSteering(followupRun, replyOperationRunState, () => {
        custodyFinished = true;
        parked.consume("consumed");
      });
      return "handled";
    }
    delivery = prepareSteeringDelivery({
      agentId: followupRun.run.agentId,
      sessionKey,
      storePath: params.storePath,
      sessionId: steerSessionId,
      sourceTurnId: injectionTarget.sourceTurnId,
      entry: params.sessionEntry,
      assertCurrent: assertReadCurrent,
    });
    const steeringDelivery = delivery;
    const inboundCaller = isInboundUserMessage
      ? resolveInboundReplyToolAuthorityOverlay({
          ctx: params.sessionCtx,
          sessionEntry: {
            ...params.sessionEntry,
            permissionMode: followupRun.run.permissionMode,
            toolOverrides: followupRun.run.toolOverrides,
          },
          senderIsOwner: followupRun.run.senderIsOwner === true,
          operatorAuthority: followupRun.operatorAuthority,
          toolsAllow: followupRun.toolsAllow,
          disableTools: followupRun.disableTools === true,
          forceRestartSafeTools: followupRun.forceRestartSafeTools,
          forceCodeModeTools: followupRun.forceCodeModeTools,
        })
      : undefined;
    const collaborativeCaller =
      followupRun.run.config.messages?.queue?.allowCollaborativeSteering === true &&
      !isExplicitCommandTurn(resolveCommandTurnContext(params.sessionCtx))
        ? inboundCaller
        : undefined;
    const {
      traceAuthorized: _trace,
      allowCollaborativeSteering: _collaboration,
      ...caller
    } = inboundCaller ?? {};
    const steeringAuthority = await prepareReplyMessageJoin({
      followupRun,
      operation: activeReplyOperation,
      target: injectionTarget,
      assertCurrent: assertReadCurrent,
      collaborativeCaller,
      delivery: steeringDelivery,
      continuation:
        inboundCaller && params.steeringIntent?.kind === "continue-existing"
          ? {
              kind: "continuation",
              caller: {
                ...caller,
                senderIsOwner: inboundCaller.senderIsOwner,
                disableTools: inboundCaller.disableTools,
              },
              config: followupRun.run.config,
              executionSelection: captureReplyExecutionSelection({
                run: followupRun.run,
                sessionEntry: params.sessionEntry,
              }),
              selectedRoute: { provider: followupRun.run.provider, model: followupRun.run.model },
              fallbackAvailability: resolveModelFallbackOptions(followupRun.run)
                .modelFallbackAvailability,
            }
          : undefined,
    });
    if (steeringAuthority.kind === "deferred") {
      return await fallback(
        steeringAuthority.reason,
        injectionTarget.runId,
        steeringAuthority.errorMessage,
      );
    }
    releaseToolAuthority = steeringAuthority.toolAuthority.release;
    assertReadCurrent();
    if (
      !isCurrentOwner() ||
      activeReplyOperation.result ||
      activeReplyOperation.abortSignal.aborted
    ) {
      return await fallback("reply-owner-ended", injectionTarget.runId);
    }
    const automaticFallbackRoute = steeringAuthority.automaticFallbackRoute;
    const isCurrentFallback = () =>
      !automaticFallbackRoute ||
      (activeReplyOperation.toolAuthorityRoute?.provider === automaticFallbackRoute.provider &&
        activeReplyOperation.toolAuthorityRoute.model === automaticFallbackRoute.model);
    if (!isCurrentFallback()) {
      return await fallback("model-fallback-changed", injectionTarget.runId);
    }
    const assertSourceCurrent = () => {
      assertReadCurrent();
      if (!isCurrentOwner()) {
        throw new Error("Reply owner changed during steering admission");
      }
      if (!isCurrentFallback()) {
        throw new Error("Automatic model fallback changed during steering admission");
      }
    };
    const assertPolicy = (fingerprint: string) => {
      assertSourceCurrent();
      if (fingerprint !== steeringAuthority.toolAuthorityFingerprint) {
        throw new Error("Steering tool authority changed");
      }
    };
    const text = followupRun.prompt;
    const assertLegacyPolicyCurrent = () => assertPolicy(steeringAuthority.toolAuthority.read());
    const injectionAttempt = await beginReplyMessageInjectionTarget(injectionTarget, text, {
      currentInboundContext: followupRun.currentInboundContext,
      inboundAudio: followupRun.currentInboundAudio === true,
      assertCurrent: assertReadCurrent,
      toolAuthorityPreparation: bindPreparedToolAuthority(
        bindWorkerToolPreparation({
          authorityKind: "source-bound" as const,
          assertCurrent: assertSourceCurrent,
          compatAssertCurrent: assertLegacyPolicyCurrent,
          prepareCurrent: async () => {
            await steeringAuthority.prepareCurrent();
            assertPolicy(steeringAuthority.toolAuthority.read());
            await steeringDelivery.prepareCurrent();
            assertSourceCurrent();
          },
        }),
      ),
      steeringMode: "all",
      isInboundUserMessage,
      terminalReplyExpectation: followupRun.run.terminalReplyExpectation,
      toolAuthorityFingerprint: steeringAuthority.toolAuthorityFingerprint,
      ...(steeringAuthority.collaborativeCaller
        ? {
            toolAuthorityOverlay: steeringAuthority.collaborativeCaller,
            allowCollaborativeSteering: true,
          }
        : {}),
      personalToolParticipant: {
        operatorAuthority: followupRun.operatorAuthority,
        requesterOrigin: followupRun.run.requesterOrigin,
        senderId: followupRun.run.senderId,
        senderName: followupRun.run.senderName,
        gatewayUiCommandTarget: followupRun.run.gatewayUiCommandTarget,
      },
      ...(steeringAuthority.pendingInputAuthorityFingerprint
        ? { pendingInputAuthorityFingerprint: steeringAuthority.pendingInputAuthorityFingerprint }
        : {}),
      ...(followupRun.images?.length ? { images: followupRun.images } : {}),
      ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
      ...(followupRun.media?.length ? { media: followupRun.media } : {}),
      waitForTranscriptCommit: true,
      queueIdentity: resolveAcceptedSteerRunId(params),
      abortSignal: resolveFollowupAbortSignal(followupRun),
      onQueueAccepted: parked.accepted,
      ...(resolvedQueue.debounceMs !== undefined ? { debounceMs: resolvedQueue.debounceMs } : {}),
      ...(followupRun.run.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
        : {}),
      taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
      ...(followupRun.userTurnTranscriptRecorder
        ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
        : {}),
    });
    nativeOutcome = injectionAttempt.outcome;
    const finalization = await finalizeReplyMessageInjectionAttempt({
      attempt: injectionAttempt,
      target: injectionTarget,
      inboundAudio: followupRun.currentInboundAudio === true,
      onOutcome: (outcome) => {
        replayForbidden = true;
        if (replyOperationRunState) {
          replyOperationRunState.admission =
            outcome === "indeterminate"
              ? { status: "skipped", reason: "question-response-indeterminate" }
              : { status: "accepted", mode: "steer" };
        }
      },
      onAdopted: () => admitFollowupRunLifecycle(followupRun),
      shouldAbortOnAdoptionError: isIngressAdoptionLostError,
    });
    if (finalization.status === "rejected") {
      if (followupRun.controllerInput?.injection?.accepted !== true) {
        return await fallback(finalization.outcome.reason, injectionAttempt.targetRunId);
      }
      // A negative final receipt cannot undo earlier native acceptance.
      parked.consume("consumed");
      custodyFinished = true;
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "steer" };
      }
      return "handled";
    }
    // Accepted or indeterminate input cannot be abandoned for replay, even
    // when the source's later adoption callback rejects.
    parked.consume("consumed");
    custodyFinished = true;
    if (finalization.status === "indeterminate") {
      return markReplyPayloadForSourceSuppressionDelivery({
        text: finalization.outcome.errorMessage,
        isError: true,
      });
    }
    if (finalization.aborted) {
      if (replyOperationRunState) {
        replyOperationRunState.messageInjectionAborted = true;
      }
      const reason = `adoption lost: ${formatErrorMessage(finalization.adoptionError)}`;
      logVerbose(
        `queue: active session ${steerSessionId} aborted exact steered target without replay (${reason})`,
      );
      return "handled";
    }
    if (finalization.adoptionError) {
      logVerbose(
        `queue: active session ${steerSessionId} adoption finalizer failed: ${formatErrorMessage(finalization.adoptionError)}`,
      );
    }
    await refreshReplyOperationTyping(activeReplyOperation, {
      startIfIdle: typingSignals.shouldStartImmediately,
    });
    await touchActiveSessionEntry();
    return "handled";
  } finally {
    try {
      if (!custodyFinished) {
        // Do not race cancellation against an in-flight native write: rejection
        // of its receipt leaves acceptance unknown and therefore forbids replay.
        if (nativeOutcome) {
          try {
            const outcome = await nativeOutcome;
            replayForbidden ||= outcome.status === "accepted" || outcome.status === "indeterminate";
          } catch {
            replayForbidden = true;
          }
        }
        if (replayForbidden || followupRun.controllerInput?.injection?.accepted === true) {
          parked.consume("consumed");
        } else {
          try {
            assertReadCurrent();
            parked.fallback();
          } catch {
            parked.consume();
          }
        }
      }
    } finally {
      releaseToolAuthority?.();
      delivery?.release();
    }
  }
}
