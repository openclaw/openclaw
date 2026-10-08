import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../../agents/harness/tool-authority-preparation.js";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { resolveReplySteeringAuthority } from "./agent-runner-fallback-authority.js";
import {
  admitFollowupRunLifecycle,
  isFollowupRunAborted,
  parkSteerCandidate,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyMessageInjectionRejectionReason } from "./reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { waitForReplyOperationBackend } from "./reply-run-registry.state.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import {
  resolveFollowupRunToolAuthorityFingerprint,
  resolveFollowupRunToolAuthorityFingerprintAsync,
} from "./reply-tool-authority.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { prepareSteeringDelivery } from "./steering-delivery-preparation.js";
import type { TypingSignaler } from "./typing-mode.js";

type ActiveReplySteerFallbackReason =
  | ReplyMessageInjectionRejectionReason
  | "admission-changed"
  | "reply-owner-ended"
  | "model-fallback-changed";

type ActiveReplySteerParams = {
  followupRun: RunReplyAgentParams["followupRun"];
  opts: RunReplyAgentParams["opts"];
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  releaseAdmissionTicket: () => void;
  replyOperationRunState: ReplyOperationRunState | undefined;
  resolvedQueue: RunReplyAgentParams["resolvedQueue"];
  restartRecoverySourceTurnId: string | undefined;
  runFollowup: (run: FollowupRun) => Promise<void>;
  sessionCtx: RunReplyAgentParams["sessionCtx"];
  sessionKey: string | undefined;
  sessionEntry?: RunReplyAgentParams["sessionEntry"];
  storePath?: string;
  touchActiveSessionEntry: () => Promise<void>;
  typing: RunReplyAgentParams["typing"];
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
    releaseAdmissionTicket,
    replyOperationRunState,
    resolvedQueue,
    runFollowup,
    sessionKey,
    touchActiveSessionEntry,
    typing,
    typingSignals,
  } = params;
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const activeReplyOperation = params.providedReplyOperation;
  const activeReplyKey = activeReplyOperation?.key;
  const readGeneration = getAgentEventLifecycleGeneration();
  const assertReadCurrent = () => {
    assertAgentRunLifecycleGenerationCurrent(readGeneration);
    resolveFollowupAbortSignal(followupRun)?.throwIfAborted();
    params.opts?.abortSignal?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
  };
  let steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
  const parked = parkSteerCandidate(queueKey, followupRun, resolvedQueue, runFollowup);
  if (!parked) {
    releaseAdmissionTicket();
    typing.cleanup();
    return "handled";
  }
  const scheduleParkedFallback = () => {
    const owner = replyRunRegistry.get(queueKey);
    if (owner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey,
        runFollowup,
      });
    } else {
      scheduleFollowupDrain(queueKey, runFollowup);
    }
  };
  scheduleParkedFallback();
  releaseAdmissionTicket();
  const fallback = async (
    reason: ActiveReplySteerFallbackReason,
    activeRunId?: string,
  ): Promise<"handled"> => {
    assertReadCurrent();
    parked.fallback();
    const queueCapRejected =
      replyOperationRunState?.admission?.status === "skipped" &&
      replyOperationRunState.admission.reason === "queue-cap";
    if (replyOperationRunState && !queueCapRejected) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    diagnosticLogger.warn("steering rejected; applying follow-up policy", {
      reason,
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
  try {
    assertReadCurrent();
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      return "handled";
    }
    if (admission === "fallback") {
      return await fallback("admission-changed");
    }
    if (
      !activeReplyOperation ||
      activeReplyKey === undefined ||
      activeReplyOperation.key !== activeReplyKey ||
      replyRunRegistry.get(activeReplyKey) !== activeReplyOperation ||
      !(await waitForReplyOperationBackend(
        activeReplyOperation,
        resolveFollowupAbortSignal(followupRun),
      )) ||
      activeReplyOperation.key !== activeReplyKey ||
      replyRunRegistry.get(activeReplyKey) !== activeReplyOperation
    ) {
      return await fallback("reply-owner-ended");
    }
    steerSessionId = activeReplyOperation.sessionId;
    // Policy preparation must not retarget input to a replacement backend.
    const injectionTarget = replyRunRegistry.resolveCurrentMessageInjectionTarget(activeReplyKey);
    if (!injectionTarget) {
      return await fallback("injection_unavailable");
    }
    const delivery = prepareSteeringDelivery({
      agentId: followupRun.run.agentId,
      sessionKey,
      storePath: params.storePath,
      sessionId: steerSessionId,
      sourceTurnId: injectionTarget.sourceTurnId,
      entry: params.sessionEntry,
      assertCurrent: assertReadCurrent,
    });
    const steeringAuthority = await resolveReplySteeringAuthority(
      followupRun,
      activeReplyOperation,
      assertReadCurrent,
    );
    assertReadCurrent();
    if (
      activeReplyOperation.key !== activeReplyKey ||
      replyRunRegistry.get(activeReplyKey) !== activeReplyOperation
    ) {
      return await fallback("reply-owner-ended", injectionTarget.runId);
    }
    if (steeringAuthority.shouldQueueAuthorityMismatch) {
      return await fallback("tool_authority_mismatch", injectionTarget.runId);
    }
    const automaticFallbackRoute = steeringAuthority.automaticFallbackRoute;
    const isCurrentFallback = () =>
      !automaticFallbackRoute ||
      (activeReplyOperation?.automaticFallbackRoute === automaticFallbackRoute &&
        activeReplyOperation.toolAuthorityRoute?.provider === automaticFallbackRoute.provider &&
        activeReplyOperation.toolAuthorityRoute.model === automaticFallbackRoute.model);
    if (!isCurrentFallback()) {
      return await fallback("model-fallback-changed", injectionTarget.runId);
    }
    const assertSourceCurrent = () => {
      assertReadCurrent();
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
    const assertLegacyPolicyCurrent = () =>
      assertPolicy(resolveFollowupRunToolAuthorityFingerprint(followupRun, automaticFallbackRoute));
    const sourceBound = Boolean(
      automaticFallbackRoute ||
      followupRun.operatorAuthority ||
      followupRun.abortSignal ||
      params.opts?.abortSignal,
    );
    const injectionAttempt = await beginReplyMessageInjectionTarget(injectionTarget, text, {
      currentInboundContext: followupRun.currentInboundContext,
      inboundAudio: followupRun.currentInboundAudio === true,
      assertCurrent: sourceBound ? assertSourceCurrent : undefined,
      toolAuthorityPreparation: bindPreparedToolAuthority(
        bindWorkerToolPreparation({
          authorityKind: sourceBound ? ("source-bound" as const) : ("run" as const),
          assertCurrent: assertSourceCurrent,
          compatAssertCurrent: assertLegacyPolicyCurrent,
          prepareCurrent: async () => {
            assertPolicy(
              await resolveFollowupRunToolAuthorityFingerprintAsync(
                followupRun,
                automaticFallbackRoute,
                assertSourceCurrent,
              ),
            );
            await delivery.prepareCurrent();
            assertSourceCurrent();
          },
        }),
      ),
      steeringMode: "all",
      isInboundUserMessage:
        followupRun.currentInboundEventKind !== "room_event" &&
        (followupRun.run.inputProvenance?.kind === undefined ||
          followupRun.run.inputProvenance.kind === "external_user"),
      terminalReplyExpectation: followupRun.run.terminalReplyExpectation,
      toolAuthorityFingerprint: steeringAuthority.toolAuthorityFingerprint,
      personalToolParticipant: {
        operatorAuthority: followupRun.operatorAuthority,
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
    const finalization = await finalizeReplyMessageInjectionAttempt({
      attempt: injectionAttempt,
      target: injectionTarget,
      inboundAudio: followupRun.currentInboundAudio === true,
      onOutcome: (outcome) => {
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
      return await fallback(finalization.outcome.reason, injectionAttempt.targetRunId);
    }
    // Accepted or indeterminate input cannot be abandoned for replay, even
    // when the source's later adoption callback rejects.
    parked.consume("consumed");
    if (finalization.status === "indeterminate") {
      return markReplyPayloadForSourceSuppressionDelivery({
        text: finalization.outcome.errorMessage,
        isError: true,
      });
    }
    const transcriptCommitUnconfirmed =
      finalization.outcome.result?.transcriptCommit === "unconfirmed";
    if (finalization.aborted) {
      if (replyOperationRunState) {
        replyOperationRunState.messageInjectionAborted = true;
      }
      const reason = transcriptCommitUnconfirmed
        ? (finalization.outcome.result?.errorMessage ?? "transcript commitment unconfirmed")
        : `adoption lost: ${formatErrorMessage(finalization.adoptionError)}`;
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
      if (followupRun.steerPending) {
        if (isFollowupRunAborted(followupRun)) {
          parked.consume();
        } else {
          try {
            assertReadCurrent();
          } catch {
            parked.consume();
          }
        }
        if (followupRun.steerPending) {
          parked.fallback();
        }
      }
    } finally {
      typing.cleanup();
    }
  }
}
