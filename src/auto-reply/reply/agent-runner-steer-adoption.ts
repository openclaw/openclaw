import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatSteerResult } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { QueuedTurnSteer } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { resolveReplySteeringAuthority } from "./agent-runner-fallback-authority.js";
import {
  admitFollowupRunLifecycle,
  parkSteerCandidate,
  reserveQueuedSteerCandidate,
  type ParkedSteerReservation,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import type { TypingSignaler } from "./typing-mode.js";

type ActiveReplySteerParams = {
  followupRun: RunReplyAgentParams["followupRun"];
  opts: RunReplyAgentParams["opts"];
  providedReplyOperation: ReplyOperation | undefined;
  automaticFallbackRoute?: ReplyOperation["automaticFallbackRoute"];
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
  toolAuthorityFingerprint: string;
  pendingInputAuthorityFingerprint?: string;
};

function resolveAcceptedSteerRunId(
  params: Omit<ActiveReplySteerParams, "releaseAdmissionTicket">,
): string {
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
  const { followupRun, queueKey, releaseAdmissionTicket, resolvedQueue, runFollowup, typing } =
    params;
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const activeReplyOperation = params.providedReplyOperation;
  // Capture exact injection authority before parking or awaiting admission.
  // A same-key successor must never inherit this turn's steer or abort.
  const injectionTarget =
    activeReplyOperation && replyRunRegistry.get(activeReplyOperation.key) === activeReplyOperation
      ? replyRunRegistry.resolveCurrentMessageInjectionTarget(activeReplyOperation.key)
      : undefined;
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
  return runParkedReplySteer(params, parked, injectionTarget);
}

type QueuedSteerControl = {
  assertCurrent: () => void;
  acknowledge: (result: ChatSteerResult) => void;
  queueIdentity: string;
  blockedReason?: string;
};

async function runParkedReplySteer(
  params: Omit<ActiveReplySteerParams, "releaseAdmissionTicket">,
  parked: ParkedSteerReservation,
  injectionTarget: ReplyMessageInjectionTarget | undefined,
  control?: QueuedSteerControl,
): Promise<"handled" | ReplyPayload> {
  const {
    followupRun,
    replyOperationRunState,
    resolvedQueue,
    sessionKey,
    touchActiveSessionEntry,
    typing,
    typingSignals,
  } = params;
  const activeReplyOperation = params.providedReplyOperation;
  const steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
  let runtimeAccepted = false;
  const fallback = async (reason?: string): Promise<"handled"> => {
    parked.fallback();
    control?.acknowledge({
      status: "queued",
      reason: reason ?? "This message cannot be steered right now. It remains queued.",
    });
    if (
      replyOperationRunState &&
      !(
        replyOperationRunState.admission?.status === "skipped" &&
        replyOperationRunState.admission.reason === "queue-cap"
      )
    ) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    if (reason) {
      logVerbose(`queue: active session ${steerSessionId} rejected steering (${reason})`);
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return "handled";
  };
  try {
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      control?.acknowledge({ status: "not_queued" });
      typing.cleanup();
      return "handled";
    }
    if (admission === "fallback") {
      return await fallback();
    }
    control?.assertCurrent();
    if (control?.blockedReason) {
      return await fallback(control.blockedReason);
    }
    if (!injectionTarget) {
      return await fallback("no injectable reply operation");
    }
    // A predecessor's admission may wait past this run's terminal delivery.
    // Keep the parked input in the ordered queue if its target is no longer eligible.
    let entry = params.sessionEntry;
    if (sessionKey && params.storePath) {
      try {
        entry =
          (await readSessionEntryInWorker(
            { sessionKey, storePath: params.storePath, agentId: followupRun.run.agentId },
            () => {
              control?.assertCurrent();
              followupRun.operatorAuthority?.assertCurrent();
            },
          )) ?? entry;
      } catch (error) {
        logVerbose(`queue: steering session entry unavailable: ${formatErrorMessage(error)}`);
        return await fallback("session-entry-unavailable");
      }
    }
    const blockReason = resolveRestartRecoverySteeringBlockReason(
      entry,
      steerSessionId,
      injectionTarget.sourceTurnId ??
        normalizeOptionalString(entry?.restartRecoveryDeliverySourceRunId) ??
        "",
    );
    if (blockReason) {
      return await fallback(`terminal source-reply delivery is closed (${blockReason})`);
    }
    const automaticFallbackRoute = params.automaticFallbackRoute;
    const isCurrentFallback = () =>
      !automaticFallbackRoute ||
      (activeReplyOperation?.automaticFallbackRoute === automaticFallbackRoute &&
        activeReplyOperation.toolAuthorityRoute?.provider === automaticFallbackRoute.provider &&
        activeReplyOperation.toolAuthorityRoute.model === automaticFallbackRoute.model);
    if (!isCurrentFallback()) {
      return await fallback("automatic model fallback changed during steering admission");
    }
    const injectionAttempt = beginReplyMessageInjectionTarget(injectionTarget, followupRun.prompt, {
      currentInboundContext: followupRun.currentInboundContext,
      inboundAudio: followupRun.currentInboundAudio === true,
      assertCurrent:
        automaticFallbackRoute || control
          ? () => {
              control?.assertCurrent();
              followupRun.operatorAuthority?.assertCurrent();
              if (!isCurrentFallback()) {
                throw new Error("Automatic model fallback changed during steering admission");
              }
            }
          : followupRun.operatorAuthority?.assertCurrent,
      steeringMode: "all",
      isInboundUserMessage:
        followupRun.currentInboundEventKind !== "room_event" &&
        (followupRun.run.inputProvenance?.kind === undefined ||
          followupRun.run.inputProvenance.kind === "external_user"),
      terminalReplyExpectation: followupRun.run.terminalReplyExpectation,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      personalToolParticipant: {
        operatorAuthority: followupRun.operatorAuthority,
        senderId: followupRun.run.senderId,
        senderName: followupRun.run.senderName,
        gatewayUiCommandTarget: followupRun.run.gatewayUiCommandTarget,
      },
      ...(params.pendingInputAuthorityFingerprint
        ? { pendingInputAuthorityFingerprint: params.pendingInputAuthorityFingerprint }
        : {}),
      ...(followupRun.images?.length ? { images: followupRun.images } : {}),
      ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
      ...(followupRun.media?.length ? { media: followupRun.media } : {}),
      waitForTranscriptCommit: true,
      queueIdentity: control?.queueIdentity ?? resolveAcceptedSteerRunId(params),
      abortSignal: resolveFollowupAbortSignal(followupRun),
      onQueueAccepted: (accepted) => {
        parked.accepted(accepted);
        if (accepted) {
          runtimeAccepted = true;
        }
      },
      ...(resolvedQueue.debounceMs !== undefined ? { debounceMs: resolvedQueue.debounceMs } : {}),
      ...(followupRun.run.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
        : {}),
      taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
      ...(followupRun.userTurnTranscriptRecorder
        ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
        : {}),
    });
    if (control) {
      void injectionAttempt.acceptance.then((accepted) => {
        if (accepted) {
          control.acknowledge({
            status: "accepted",
            ...(injectionAttempt.targetRunId ? { targetRunId: injectionAttempt.targetRunId } : {}),
          });
        }
      });
    }
    const finalization = await finalizeReplyMessageInjectionAttempt({
      attempt: injectionAttempt,
      target: injectionTarget,
      inboundAudio: followupRun.currentInboundAudio === true,
      onOutcome: (outcome) => {
        runtimeAccepted = true;
        control?.acknowledge({
          status: "accepted",
          ...(injectionAttempt.targetRunId ? { targetRunId: injectionAttempt.targetRunId } : {}),
        });
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
      return await fallback(finalization.outcome.reason);
    }
    // Accepted or indeterminate input cannot be abandoned for replay, even
    // when the source's later adoption callback rejects.
    parked.consume("consumed");
    if (finalization.status === "indeterminate") {
      typing.cleanup();
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
      typing.cleanup();
      return "handled";
    }
    if (finalization.adoptionError) {
      logVerbose(
        `queue: active session ${steerSessionId} adoption finalizer failed: ${formatErrorMessage(finalization.adoptionError)}`,
      );
    }
    if (activeReplyOperation) {
      await refreshReplyOperationTyping(activeReplyOperation, {
        startIfIdle: typingSignals.shouldStartImmediately,
      });
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return "handled";
  } catch (error) {
    if (runtimeAccepted) {
      // An error after custody transfer is not permission to replay the input.
      parked.consume("consumed");
    } else if (resolveFollowupAbortSignal(followupRun)?.aborted) {
      parked.consume();
    } else {
      parked.fallback();
    }
    throw error;
  } finally {
    if (followupRun.steerPending) {
      if (resolveFollowupAbortSignal(followupRun)?.aborted) {
        parked.consume();
      } else {
        parked.fallback();
      }
    }
  }
}

type QueuedReplySteerParams = Omit<
  ActiveReplySteerParams,
  | "providedReplyOperation"
  | "automaticFallbackRoute"
  | "toolAuthorityFingerprint"
  | "pendingInputAuthorityFingerprint"
  | "releaseAdmissionTicket"
>;

/** The original queued source owns promotion through settlement, independently of the RPC. */
export function createQueuedReplySteer(params: QueuedReplySteerParams): QueuedTurnSteer {
  let inFlight: Promise<ChatSteerResult> | undefined;
  return (assertRequestCurrent) => {
    assertRequestCurrent();
    if (inFlight) {
      return inFlight;
    }
    const { followupRun, queueKey } = params;
    const holdSteering = followupRun.turnAdoptionLifecycle?.holdSteering;
    const releaseSteering = holdSteering?.();
    if (holdSteering && !releaseSteering) {
      return Promise.resolve({ status: "not_queued" });
    }
    let parked: ParkedSteerReservation | undefined;
    try {
      parked = reserveQueuedSteerCandidate(queueKey, followupRun);
    } catch (error) {
      releaseSteering?.();
      throw error;
    }
    if (!parked) {
      releaseSteering?.();
      return Promise.resolve({ status: "not_queued" });
    }
    try {
      // Resolve once, before the first await. Neither waiting nor fallback may retarget a successor.
      const operation = replyRunRegistry.get(queueKey);
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(queueKey);
      const steeringAuthority = resolveReplySteeringAuthority(followupRun, operation);
      const acknowledgment = createDeferredCore<ChatSteerResult>();
      inFlight = acknowledgment.promise;
      let acknowledged = false;
      let assertActionCurrent: (() => void) | undefined = assertRequestCurrent;
      const acknowledge = (result: ChatSteerResult) => {
        if (acknowledged) {
          return;
        }
        acknowledged = true;
        // Runtime custody outlives this control request. Only its request guard is retired.
        assertActionCurrent = undefined;
        acknowledgment.resolve(result);
      };
      const sourceRunId = expectDefined(
        params.opts?.runId ?? followupRun.messageId ?? followupRun.sourceTurnId,
        "queued steering source id",
      );
      const settlement = runParkedReplySteer(
        {
          ...params,
          providedReplyOperation: operation,
          ...steeringAuthority,
        },
        parked,
        target,
        {
          assertCurrent: () => {
            parked.assertCurrent();
            assertActionCurrent?.();
          },
          acknowledge,
          queueIdentity: sourceRunId,
          ...(steeringAuthority.shouldQueueAuthorityMismatch
            ? { blockedReason: "tool authority changed" }
            : {}),
        },
      );
      // Attach settlement before returning the acknowledgment. A transport timeout cannot abandon
      // accepted input, and all peers share this source until its receipt and lifecycle settle.
      void settlement
        .then(async (result) => {
          if (
            result !== "handled" &&
            followupRun.queuedFollowupReplyDisposition?.kind === "deliver"
          ) {
            await followupRun.queuedFollowupReplyDisposition.deliver({
              kind: "queued-followup",
              runId: sourceRunId,
              originatingChannel: followupRun.originatingChannel,
              payloads: [result],
              completion: {
                kind: "failed",
                error: result.text ?? "Steering could not be confirmed",
              },
            });
          }
        })
        .finally(() => {
          assertActionCurrent = undefined;
          try {
            releaseSteering?.();
          } finally {
            inFlight = undefined;
          }
        })
        .catch((error: unknown) => {
          if (!acknowledged) {
            acknowledgment.reject(error);
          } else {
            logVerbose(
              "queue: source " +
                sourceRunId +
                " steering settlement failed: " +
                formatErrorMessage(error),
            );
          }
        });
      return acknowledgment.promise;
    } catch (error) {
      try {
        parked.fallback();
      } finally {
        try {
          releaseSteering?.();
        } finally {
          inFlight = undefined;
        }
      }
      throw error;
    }
  };
}
