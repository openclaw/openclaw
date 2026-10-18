import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { renderAgentHarnessPreflightUserMessage } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { isReplyPayloadStatusNotice } from "../../auto-reply/reply-payload.js";
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
import { waitForChatAbortTerminalPersistence } from "../chat-abort-lifecycle-internal.js";
import { errorShapeFromError } from "../error-shape.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { chatAbortMarkerTimestampMs, type ChatAbortMarker } from "../server-chat-state.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { formatForLog } from "../ws-log.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatError, broadcastChatTerminal } from "./chat-broadcast.js";
import type { RestartSafeChatTerminalState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  readChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import {
  classifyAcceptedChatSendFailure,
  shouldRetainAcceptedChatSendRetryIdentity,
  type AcceptedChatSendFailureDisposition,
} from "./chat-send-retry.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

function formatReturnedAgentErrors(messages: string[]): string | undefined {
  const [primary, ...additional] = [...new Set(messages)];
  if (!primary || additional.length === 0) {
    return primary;
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
  const returnedAgentErrorMessage =
    runtimeOutcome?.error ??
    (formatReturnedAgentErrors(
      returnedAgentErrorPayloads
        .map((payload) => payload.text?.trim())
        .filter((text): text is string => Boolean(text)),
    ) ||
      (runtimeFailed ? "agent run failed" : undefined));
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
  terminationFields: ReturnType<typeof resolveAgentRunErrorLifecycleFields>;
  endedAt: number;
  error: string;
  errorKind?: "state_contention";
  sessionId: string;
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
    renderAgentHarnessPreflightUserMessage(error) ??
    renderFailoverCodeUserCopy(describeFailoverError(error).code) ??
    String(error)
  );
}

/** Finalize a chat.send that throws before detached dispatch owns cleanup. */
type ChatSendJobAdmission = Pick<
  AdmittedChatSend,
  "activeRunAbort" | "cleanupAdmittedRun" | "lifecycleGeneration" | "restartSafeAdmission"
>;

export async function handleChatSendSetupError(params: {
  cacheResult?: boolean;
  admission: ChatSendJobAdmission;
  context: GatewayRequestContext;
  error: unknown;
  respond: RespondFn;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey">;
  terminalizeRestartSafeAdmission: (state: RestartSafeChatTerminalState) => Promise<boolean>;
}): Promise<void> {
  const { cleanupAdmittedRun, lifecycleGeneration, restartSafeAdmission } = params.admission;
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
  // Before acknowledgment the browser still owns retry. Do not manufacture a
  // terminal receipt or retire a committed recovery claim for an expected restart.
  const failureDisposition = restart
    ? "client-retry"
    : classifyAcceptedChatSendFailure({
        error: params.error,
        phase: "pre-ack",
      });
  if (restartSafeAdmission && !restart) {
    const terminalized = await params
      .terminalizeRestartSafeAdmission({
        error: errorMessage,
        errorKind,
        retryable: shouldRetainAcceptedChatSendRetryIdentity(failureDisposition),
        status: "failed",
      })
      .catch((terminalizeError: unknown) => {
        params.context.logGateway.warn(
          `failed to release restart-safe chat admission after setup error: ${formatForLog(
            terminalizeError,
          )}`,
        );
        return false;
      });
    if (terminalized) {
      emitSessionsChanged(params.context, {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        reason: "chat.dispatch-error",
      });
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
  classifyFailure?: (error: unknown) => AcceptedChatSendFailureDisposition;
  isReplyDispatchRun?: () => boolean;
  persistUserTurnTranscript: () => Promise<unknown>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "cfg" | "clientRunId" | "now" | "rawSessionKey" | "sessionKey" | "storePath"
  >;
  terminalizeRestartSafeAdmission: (state: RestartSafeChatTerminalState) => Promise<boolean>;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "hasPersisted" | "isBlocked">;
}) {
  const {
    admission,
    context,
    isQueuedFollowupEnqueued,
    persistUserTurnTranscript,
    session,
    terminalizeRestartSafeAdmission,
    userTurnRecorder,
  } = params;
  const { activeRunAbort, cleanupAdmittedRun, lifecycleGeneration, restartSafeAdmission } =
    admission;
  const { agentId, cfg, clientRunId, now, rawSessionKey, sessionKey, storePath } = session;
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

  const broadcastError = (
    error: Pick<
      Parameters<typeof broadcastChatError>[0],
      "errorMessage" | "errorKind" | "stopReason"
    >,
  ) => {
    if (
      !hidden &&
      (params.isReplyDispatchRun?.() ||
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

  const handleError = async (err: unknown) => {
    const errorMessage = formatChatSendError(err);
    const errorKind = resolveStateContentionPresentation(err)?.errorKind;
    const failureDisposition =
      params.classifyFailure?.(err) ??
      classifyAcceptedChatSendFailure({ error: err, phase: "post-ack" });
    const queuedFollowupEnqueued = isQueuedFollowupEnqueued();
    if (queuedFollowupEnqueued) {
      context.logGateway.warn(
        `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
      );
      return;
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
      // A competing restart-admission write can strand an acknowledged abort.
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

    let restartSafeDispatchFailureTerminalized = false;
    if (
      restartSafeAdmission &&
      !agentTerminalOwnedAtDispatchReject &&
      terminationFields.stopReason !== "restart"
    ) {
      restartSafeDispatchFailureTerminalized = await terminalizeRestartSafeAdmission({
        error: errorMessage,
        errorKind,
        retryable: shouldRetainAcceptedChatSendRetryIdentity(failureDisposition),
        status: "failed",
      }).catch((terminalizeError: unknown) => {
        context.logGateway.warn(
          `failed to release restart-safe chat admission after dispatch error: ${formatForLog(
            terminalizeError,
          )}`,
        );
        return false;
      });
      if (restartSafeDispatchFailureTerminalized) {
        emitSessionsChanged(context, {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          reason: "chat.dispatch-error",
        });
      }
    }
    persistDispatchErrorUserTurn =
      userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
        ? undefined
        : async () => {
            await persistUserTurnTranscript();
          };
    if (
      !suppressLifecycle &&
      !restartSafeDispatchFailureTerminalized &&
      abortMarkerAtDispatchReject === undefined &&
      !agentTerminalOwnedAtDispatchReject
    ) {
      pendingDispatchLifecycleError = {
        terminationFields,
        endedAt: Date.now(),
        error: errorMessage,
        errorKind,
        sessionId: getRpcSourceIdentity(activeRunAbort.entry).sessionId,
        startedAt: getRpcSourceStartedAt(activeRunAbort.entry) ?? now,
      };
    }
    if (!agentTerminalOwnedAtDispatchReject || params.isReplyDispatchRun?.()) {
      // Native lifecycle owns its replay result; dispatched runtimes leave
      // failure projection to this owner, including transcript-write failures.
      const publish = () => {
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
    if (!dispatchError) {
      const abortMarker =
        abortedDispatchMarker ??
        (activeRunAbort.controller.signal.aborted
          ? context.chatRunState.runs.get(clientRunId)?.abortMarker
          : undefined);
      if (abortMarker) {
        if (restartSafeAdmission && !params.isAgentRunStarted()) {
          const terminalized = await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry.adapter.abortStopReason === "restart",
            status: "killed",
          }).catch((terminalizeError: unknown) => {
            context.logGateway.warn(
              `failed to release restart-safe chat admission after abort: ${formatForLog(
                terminalizeError,
              )}`,
            );
            return false;
          });
          if (terminalized) {
            emitSessionsChanged(context, {
              sessionKey,
              ...(agentId ? { agentId } : {}),
              reason: "chat.abort",
            });
          }
        }
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
      clearRun();
      cleanupAdmittedRun();
      // Reply-dispatch lifecycle events deliberately retain these until delivery settles.
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      return;
    }
    // Stop exposing the rejected run before projecting its terminal state, but keep the
    // admitted root until persistence settles so restart drain still observes this work.
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    context.removeChatRun(clientRunId, clientRunId, sessionKey);
    try {
      // The lifecycle owner may append a failure notice; keep its input first.
      await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
        context.logGateway.warn(
          `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
        );
      });
      const hasActiveRun = hasTrackedActiveSessionRun({
        storePath,
        resolveGatewayContext: context.resolveGatewayContext,
        requestedKey: rawSessionKey,
        canonicalKey: sessionKey,
        ...(agentId ? { agentId } : {}),
        defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey),
      });
      if (!hasActiveRun) {
        try {
          await persistGatewaySessionLifecycleEvent({
            sessionKey,
            ...(agentId ? { agentId } : {}),
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
      }
    } catch (continuationErr: unknown) {
      context.logGateway.warn(
        `webchat session lifecycle continuation failed: ${formatForLog(continuationErr)}`,
      );
    } finally {
      try {
        publishDispatchError?.();
      } finally {
        clearRun();
        cleanupAdmittedRun();
      }
    }
  };

  return { broadcastError, finalize, handleError };
}
