import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { renderAgentHarnessPreflightUserMessage } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { isReplyPayloadStatusNotice, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { COLLABORATIVE_STEERING_DISABLED_TEXT } from "../../auto-reply/reply/dispatch-from-config.payloads.js";
import { DispatchSessionRefreshRequiredError } from "../../auto-reply/reply/dispatch-session-refresh-error.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import { clearAgentRunContext, getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceStartedAt,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import {
  captureChatAbortRegistrationGuard,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { errorShapeFromError } from "../error-shape.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { chatAbortMarkerTimestampMs, type ChatAbortMarker } from "../server-chat-state.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { formatForLog } from "../ws-log.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatError, broadcastChatTerminal } from "./chat-broadcast.js";
import { resolveChatSendStorageErrorMessage } from "./chat-send-admission-errors.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  readChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import type { createChatSendInjectionDisposition } from "./chat-send-message-injection.js";
import {
  classifyAcceptedChatSendFailure,
  type AcceptedChatSendFailureDisposition,
} from "./chat-send-retry.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

function formatReturnedAgentErrors(params: {
  payloads: Pick<ReplyPayload, "text">[];
  runtimeError?: string;
  runtimeFailed: boolean;
  collaborativeSteeringRefused?: boolean;
}): string | undefined {
  if (params.collaborativeSteeringRefused) {
    return COLLABORATIVE_STEERING_DISABLED_TEXT;
  }
  if (params.runtimeError !== undefined) {
    return params.runtimeError;
  }
  const messages = params.payloads
    .map((payload) => payload.text?.trim())
    .filter((text): text is string => Boolean(text));
  const [primary, ...additional] = [...new Set(messages)];
  if (!primary || additional.length === 0) {
    return primary || (params.runtimeFailed ? "agent run failed" : undefined);
  }
  if (additional.length === 1) {
    return `${primary}\n\nAdditional error: ${additional[0]}`;
  }
  return `${primary}\n\nAdditional errors:\n${additional.map((message) => `- ${message}`).join("\n")}`;
}

export function resolveChatSendReturnedOutcome(params: {
  dispatchResult: unknown;
  runtimeOutcome: AgentRunTerminalOutcome | undefined;
  deliveredReplies: readonly DeliveredChatSendReply[];
  agentRunStarted: boolean;
  isInternalTextSlashCommandTurn: boolean;
  collaborativeSteeringRefused?: boolean;
}) {
  const { runtimeOutcome, deliveredReplies, agentRunStarted, isInternalTextSlashCommandTurn } =
    params;
  const recordedOutcome = readAgentRunTerminalOutcome(params.dispatchResult);
  // ACP owns a rich terminal result; native runs record their outcome on dispatch.
  // Delivered warnings or source replies cannot replace either authoritative result.
  const runtimeClassification = runtimeOutcome
    ? classifyAgentRunTerminalOutcome(runtimeOutcome)
    : recordedOutcome && (recordedOutcome === "failed" ? "failure" : "success");
  const runtimeCancelled = runtimeClassification === "cancellation";
  const runtimeFailed = runtimeClassification === "failure" || runtimeClassification === "timeout";
  const returnedAgentErrorPayloads = deliveredReplies
    .map((entry) => readChatSendReplyPayload(entry.input))
    .filter((payload) => payload.isError);
  // Native streams cannot publish a host-authored warning. Give a warning-only
  // turn the normal reply owner without reclassifying the runtime outcome.
  const hasOnlyFinalWarnings =
    returnedAgentErrorPayloads.length > 0 &&
    deliveredReplies.every(({ kind, input }) => {
      const payload = readChatSendReplyPayload(input);
      return (kind === "final" && payload.isError === true) || isReplyPayloadStatusNotice(payload);
    });
  const hasReturnedAgentError = runtimeClassification
    ? runtimeFailed
    : returnedAgentErrorPayloads.length > 0 && (agentRunStarted || !isInternalTextSlashCommandTurn);
  const returnedAgentErrorMessage = formatReturnedAgentErrors({
    payloads: returnedAgentErrorPayloads,
    runtimeError: runtimeOutcome?.error,
    runtimeFailed,
    collaborativeSteeringRefused: params.collaborativeSteeringRefused,
  });
  return {
    runtimeClassification,
    runtimeCancelled,
    runtimeFailed,
    returnedAgentErrorPayloads,
    hasOnlyFinalWarnings,
    hasReturnedAgentError,
    returnedAgentErrorMessage,
  };
}

type PendingDispatchLifecycleError = {
  allowUnstartedFailure?: true;
  terminationFields: ReturnType<typeof resolveAgentRunErrorLifecycleFields>;
  endedAt: number;
  error: string;
  errorKind?: "state_contention";
  sessionId: string;
  lifecycleRevision?: string;
  startedAt: number;
};

function formatChatSendError(error: unknown): string {
  if (error instanceof DispatchSessionRefreshRequiredError) {
    return (
      "Your message didn't run because the conversation changed. Refresh the conversation, then send it again." +
      `\n\n${String(error)}`
    );
  }
  return (
    resolveStateContentionPresentation(error)?.errorMessage ??
    resolveChatSendStorageErrorMessage(error) ??
    renderAgentHarnessPreflightUserMessage(error) ??
    renderFailoverCodeUserCopy(describeFailoverError(error).code) ??
    String(error)
  );
}

/** Finalize a chat.send that throws before detached dispatch owns cleanup. */
type ChatSendJobAdmission = Pick<
  AdmittedChatSend,
  "activeRunAbort" | "cleanupAdmittedRun" | "lifecycleGeneration"
> &
  Partial<Pick<AdmittedChatSend, "initialSessionEntry" | "recordFailureNotice">>;

export async function handleChatSendSetupError(params: {
  cacheResult?: boolean;
  committedInput?: { sessionId: string; lifecycleRevision?: string };
  admission: ChatSendJobAdmission;
  context: GatewayRequestContext;
  error: unknown;
  respond: RespondFn;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey">;
}): Promise<void> {
  const { cleanupAdmittedRun, lifecycleGeneration } = params.admission;
  const { agentId, clientRunId, sessionKey } = params.session;
  const hidden = getAgentRunContext(clientRunId)?.projectSessionMessages === false;
  if (params.error instanceof ExpectedProfileMismatchError) {
    // Selection failure belongs to this request, not the run's recorded outcome.
    // Release only this admission; never poison a receipt or replay cache.
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    params.context.removeChatRun(clientRunId, clientRunId, sessionKey);
    params.respond(false, undefined, params.error.error);
    return;
  }
  const errorMessage = formatChatSendError(params.error);
  const errorKind = resolveStateContentionPresentation(params.error)?.errorKind;
  const restart =
    resolveAgentRunErrorLifecycleFields(params.error, undefined).stopReason === "restart";
  // Before acknowledgment the browser still owns retry after an expected restart.
  const failureDisposition = restart
    ? "client-retry"
    : classifyAcceptedChatSendFailure({
        error: params.error,
        phase: "pre-ack",
      });
  if (
    params.committedInput &&
    failureDisposition !== "client-retry" &&
    getAgentRunContext(clientRunId)?.projectSessionLifecycle !== false
  ) {
    const endedAt = Date.now();
    try {
      await persistGatewaySessionLifecycleEvent({
        sessionKey,
        agentId,
        expectedWriter: { runId: clientRunId, ...params.committedInput },
        event: {
          runId: clientRunId,
          sessionId: params.committedInput.sessionId,
          lifecycleGeneration,
          ts: endedAt,
          data: {
            phase: "error",
            startedAt: getRpcSourceStartedAt(params.admission.activeRunAbort.entry),
            endedAt,
            error: errorMessage,
            errorKind,
          },
        },
      });
      emitSessionsChanged(params.context, { sessionKey, agentId, reason: "chat.setup-error" });
    } catch (persistError) {
      params.context.logGateway.warn(
        `webchat session lifecycle persist failed after setup error: ${formatForLog(persistError)}`,
      );
    }
  }
  cleanupAdmittedRun();
  clearAgentRunContext(clientRunId, lifecycleGeneration);
  params.context.removeChatRun(clientRunId, clientRunId, sessionKey);
  const error =
    params.error instanceof SessionMutationAuthorizationChangedError
      ? params.error.error
      : params.error instanceof SessionGoalOperationError
        ? errorShape(ErrorCodes.INVALID_REQUEST, params.error.message, {
            details: { code: "GOAL_OPERATION_REJECTED", reason: params.error.code },
          })
        : errorShapeFromError(ErrorCodes.UNAVAILABLE, params.error, {
            message: errorMessage,
            ...(failureDisposition === "client-retry"
              ? { retryable: true, retryAfterMs: 250 }
              : {}),
          });
  const payload = { runId: clientRunId, status: "error" as const, summary: errorMessage };
  if (params.cacheResult !== false && failureDisposition !== "client-retry") {
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${clientRunId}`,
      session: captureAgentJobSession({
        ...getRpcSourceIdentity(params.admission.activeRunAbort.entry),
        lifecycleGeneration: getRpcSourceLifecycleGeneration(params.admission.activeRunAbort.entry),
      }),
      entry: { ts: Date.now(), ok: false, payload, error },
    });
  }
  params.respond(false, payload, error, { runId: clientRunId, error: formatForLog(params.error) });
  if (!hidden && failureDisposition !== "client-retry") {
    broadcastChatError({
      terminalEntry: params.admission.activeRunAbort.entry,
      context: params.context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage,
      errorKind,
    });
  }
}

/** Own dispatch settlement and post-cleanup lifecycle persistence. */
export function createChatSendDispatchErrorLifecycle(params: {
  admission: ChatSendJobAdmission;
  context: GatewayRequestContext;
  isAgentRunStarted: () => boolean;
  isQueuedFollowupEnqueued: () => boolean;
  hasObservedSideEffects?: () => boolean;
  isReplyDispatchRun?: () => boolean;
  injectionDisposition?: ReturnType<typeof createChatSendInjectionDisposition>;
  persistUserTurnTranscript: () => Promise<unknown>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "cfg" | "clientRunId" | "now" | "rawSessionKey" | "sessionKey" | "storePath"
  > &
    Partial<Pick<PreparedChatSendSession, "entry">>;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "hasPersisted" | "isBlocked">;
}) {
  const {
    admission,
    context,
    isQueuedFollowupEnqueued,
    persistUserTurnTranscript,
    session,
    userTurnRecorder,
  } = params;
  const { activeRunAbort, cleanupAdmittedRun, lifecycleGeneration } = admission;
  const { agentId, clientRunId, now, sessionKey } = session;
  const isSourceCurrent = captureChatAbortRegistrationGuard([
    { runId: clientRunId, entry: activeRunAbort.entry },
  ]);
  const captureJobSession = () =>
    captureAgentJobSession({
      ...getRpcSourceIdentity(activeRunAbort.entry),
      lifecycleGeneration: getRpcSourceLifecycleGeneration(activeRunAbort.entry),
    });
  // Cleanup releases the run context before delayed failure publication. Keep
  // the original projection policy so maintenance cannot become a visible turn.
  const visibility = getAgentRunContext(clientRunId);
  const hidden = visibility?.projectSessionMessages === false;
  const suppressLifecycle = visibility?.projectSessionLifecycle === false;
  let abortedDispatchMarker: ChatAbortMarker | undefined;
  let pendingDispatchLifecycleError: PendingDispatchLifecycleError | undefined;
  let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;
  let publishDispatchError: (() => void) | undefined;
  const classifyFailure = (error: unknown): AcceptedChatSendFailureDisposition =>
    params.injectionDisposition?.isRefused()
      ? "reconcile"
      : classifyAcceptedChatSendFailure({
          error,
          phase: "post-ack",
          executionStarted: params.isAgentRunStarted(),
          sideEffectsObserved: params.hasObservedSideEffects?.(),
        });

  const broadcastError = (
    error: Pick<
      Parameters<typeof broadcastChatError>[0],
      "errorMessage" | "errorKind" | "stopReason"
    >,
  ) => {
    if (
      !hidden &&
      (params.isReplyDispatchRun?.() ||
        activeRunAbort.entry.adapter.chatErrorDispatchOwned === true ||
        activeRunAbort.entry.adapter.terminalOutcomeObserved !== true)
    ) {
      if (error.stopReason === "restart") {
        broadcastChatTerminal({
          terminalEntry: activeRunAbort.entry,
          context,
          runId: clientRunId,
          sessionKey,
          agentId,
          state: "aborted",
          stopReason: "restart",
        });
      } else {
        broadcastChatError({
          terminalEntry: activeRunAbort.entry,
          context,
          runId: clientRunId,
          sessionKey,
          agentId,
          ...error,
        });
      }
    }
  };

  const handleError = async (dispatchError: unknown) => {
    let err = dispatchError;
    try {
      await params.injectionDisposition?.settleRefusal();
    } catch (settlementError) {
      err = new AggregateError([err, settlementError], "Refused input custody could not settle");
    }
    const errorMessage = formatChatSendError(err);
    const errorKind = resolveStateContentionPresentation(err)?.errorKind;
    const queuedFollowupEnqueued = isQueuedFollowupEnqueued();
    if (queuedFollowupEnqueued) {
      context.logGateway.warn(
        `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
      );
      return;
    }

    if (activeRunAbort.entry.adapter.terminalOutcomeObserved === true) {
      // Lifecycle observation precedes lazy delivery. Join only that accepted
      // terminal, not this dispatch's own source-completion receipt.
      await waitForChatAbortTerminalPersistence(activeRunAbort.entry).catch((error: unknown) => {
        context.logGateway.warn(
          `webchat terminal lifecycle settlement failed: ${formatForLog(error)}`,
        );
      });
    }

    // Capture ownership before cleanup yields. Preparation also aborts this
    // controller, so only typed reasons establish cancellation, not its failures.
    const signalTermination = resolveAgentRunErrorLifecycleFields(
      activeRunAbort.controller.signal.reason,
      undefined,
    );
    const terminationFields = signalTermination.stopReason
      ? signalTermination
      : resolveAgentRunErrorLifecycleFields(err, undefined);
    const abortedAtDispatchReject = activeRunAbort.controller.signal.aborted;
    const abortMarkerAtDispatchReject = context.chatRunState.runs.get(clientRunId)?.abortMarker;
    const agentTerminalOwnedAtDispatchReject =
      activeRunAbort.entry.adapter.terminalOutcomeObserved === true;

    if (abortedAtDispatchReject && abortMarkerAtDispatchReject !== undefined) {
      // chat.abort has already emitted the canonical terminal lifecycle and
      // retained its registration until that durable projection settles.
      abortedDispatchMarker = abortMarkerAtDispatchReject;
      context.logGateway.warn(
        `chat.send post-dispatch threw after abort for runId=${clientRunId}: ${formatForLog(err)}`,
      );

      const shouldPersistUserTurn =
        !userTurnRecorder.hasPersisted() && !userTurnRecorder.isBlocked();
      if (shouldPersistUserTurn) {
        try {
          await persistUserTurnTranscript();
        } catch (transcriptError: unknown) {
          context.logGateway.warn(
            `webchat user transcript update failed after abort: ${formatForLog(transcriptError)}`,
          );
        }
      }
      return;
    }

    context.chatRunState.deleteAbortMarker(clientRunId);
    activeRunAbort.cleanup();

    persistDispatchErrorUserTurn =
      userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
        ? undefined
        : async () => {
            await persistUserTurnTranscript();
          };
    if (
      !suppressLifecycle &&
      abortMarkerAtDispatchReject === undefined &&
      !agentTerminalOwnedAtDispatchReject
    ) {
      pendingDispatchLifecycleError = {
        allowUnstartedFailure: !params.isAgentRunStarted() ? true : undefined,
        terminationFields,
        endedAt: Date.now(),
        error: errorMessage,
        errorKind,
        sessionId: getRpcSourceIdentity(activeRunAbort.entry).sessionId,
        lifecycleRevision:
          session.entry?.lifecycleRevision ?? admission.initialSessionEntry?.lifecycleRevision,
        startedAt: getRpcSourceStartedAt(activeRunAbort.entry) ?? now,
      };
    }
    if (
      !agentTerminalOwnedAtDispatchReject ||
      params.isReplyDispatchRun?.() ||
      activeRunAbort.entry.adapter.chatErrorDispatchOwned === true
    ) {
      // Native lifecycle owns its replay result; dispatched runtimes leave
      // failure projection to this owner, including transcript-write failures.
      const publish = () => {
        if (!isSourceCurrent()) {
          return;
        }
        const restart = terminationFields.stopReason === "restart";
        const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, err, { message: errorMessage });
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          session: captureJobSession(),
          entry: {
            ts: Date.now(),
            ok: restart,
            payload: restart
              ? buildAbortedChatSendPayload({
                  runId: clientRunId,
                  stopReason: "restart",
                  endedAt: pendingDispatchLifecycleError?.endedAt ?? Date.now(),
                })
              : {
                  runId: clientRunId,
                  status: "error" as const,
                  summary: errorMessage,
                  ...terminationFields,
                },
            ...(restart ? {} : { error }),
          },
        });
        broadcastError({ errorMessage, errorKind, stopReason: terminationFields.stopReason });
      };
      if (pendingDispatchLifecycleError) {
        // agent.wait consumes the cached terminal immediately. Commit the lifecycle
        // first so registry completion cannot race it with a later start timestamp.
        publishDispatchError = publish;
      } else {
        publish();
      }
    }
  };

  const finalize = async () => {
    if (params.isReplyDispatchRun?.() && activeRunAbort.entry) {
      // Accepted lifecycle delivery still needs this exact registration and run context.
      await waitForChatAbortTerminalPersistence(activeRunAbort.entry).catch((error: unknown) => {
        context.logGateway.warn(
          `webchat terminal lifecycle settlement failed: ${formatForLog(error)}`,
        );
      });
    }
    const dispatchError = pendingDispatchLifecycleError;
    // Commands and reply-dispatch runtimes have already published their terminal.
    // Native agent events keep ownership until their own terminal delivery completes.
    const clearRun = () => {
      if (
        !isQueuedFollowupEnqueued() &&
        (!params.isAgentRunStarted() || params.isReplyDispatchRun?.())
      ) {
        context.chatRunState.clearRun(clientRunId);
        context.agentRunSeq.delete(clientRunId);
      }
    };
    try {
      if (!dispatchError) {
        const abortMarker =
          abortedDispatchMarker ??
          (activeRunAbort.controller.signal.aborted
            ? context.chatRunState.runs.get(clientRunId)?.abortMarker
            : undefined);
        if (abortMarker) {
          const endedAt = chatAbortMarkerTimestampMs(abortMarker);
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            session: captureJobSession(),
            entry: {
              ts: endedAt,
              ok: true,
              payload: buildAbortedChatSendPayload({
                runId: clientRunId,
                stopReason: activeRunAbort.entry.adapter.abortStopReason ?? "rpc",
                endedAt,
              }),
            },
          });
        }
        // Reply-dispatch lifecycle events deliberately retain these until delivery settles.
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        context.removeChatRun(clientRunId, clientRunId, sessionKey);
        return;
      }
      // Keep the input even if removing the rejected run's projection fails.
      await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
        context.logGateway.warn(
          `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
        );
      });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      try {
        // A yielded source can still hold its own controller claim. The
        // exact writer gate permits its failure without ending a successor.
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          ...(agentId ? { agentId } : {}),
          expectedWriter: {
            ...(dispatchError.allowUnstartedFailure ? { allowUnstartedFailure: true } : {}),
            runId: clientRunId,
            sessionId: dispatchError.sessionId,
            lifecycleRevision: dispatchError.lifecycleRevision,
          },
          assertCommitAllowed: () => {
            if (!isSourceCurrent()) {
              throw new Error("Chat input was replaced before its failure could be persisted");
            }
          },
          event: {
            runId: clientRunId,
            sessionId: dispatchError.sessionId,
            lifecycleGeneration,
            ts: dispatchError.endedAt,
            data: {
              phase: "error",
              startedAt: dispatchError.startedAt,
              endedAt: dispatchError.endedAt,
              error: dispatchError.error,
              errorKind: dispatchError.errorKind,
              ...dispatchError.terminationFields,
            },
          },
        });
        if (!hidden && !dispatchError.terminationFields.aborted) {
          await admission.recordFailureNotice?.({
            runId: clientRunId,
            error: dispatchError.error,
            errorKind: dispatchError.errorKind,
          });
        }
        emitSessionsChanged(context, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          reason: "chat.dispatch-error",
        });
      } catch (persistErr: unknown) {
        context.logGateway.warn(
          `webchat session lifecycle persist failed after error: ${formatForLog(persistErr)}`,
        );
      }
    } finally {
      try {
        publishDispatchError?.();
      } finally {
        clearRun();
        cleanupAdmittedRun();
      }
    }
  };

  return { broadcastError, classifyFailure, finalize, handleError };
}
