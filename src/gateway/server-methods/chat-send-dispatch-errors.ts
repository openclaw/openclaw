import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { renderAgentHarnessPreflightUserMessage } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { DispatchSessionRefreshRequiredError } from "../../auto-reply/reply/dispatch-session-refresh-error.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import { clearAgentRunContext, getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { chatAbortMarkerTimestampMs, type ChatAbortMarker } from "../server-chat-state.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { formatForLog } from "../ws-log.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { RestartSafeChatTerminalState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  classifyAcceptedChatSendFailure,
  shouldRetainAcceptedChatSendRetryIdentity,
  type AcceptedChatSendFailureDisposition,
} from "./chat-send-retry.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function formatReturnedAgentErrors(messages: string[]): string | undefined {
  const [primary, ...additional] = [...new Set(messages)];
  if (!primary || additional.length === 0) {
    return primary;
  }
  if (additional.length === 1) {
    return `${primary}\n\nAdditional error: ${additional[0]}`;
  }
  return `${primary}\n\nAdditional errors:\n${additional.map((message) => `- ${message}`).join("\n")}`;
}

type PendingDispatchLifecycleError = {
  endedAt: number;
  error: string;
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
    renderAgentHarnessPreflightUserMessage(error) ??
    renderFailoverCodeUserCopy(describeFailoverError(error).code) ??
    String(error)
  );
}

/** Finalize a chat.send that throws before detached dispatch owns cleanup. */
type ChatSendJobAdmission = Pick<
  AdmittedChatSend,
  "cleanupAdmittedRun" | "lifecycleGeneration" | "restartSafeAdmission"
> & {
  sessionBinding: Pick<
    AdmittedChatSend["sessionBinding"],
    "sessionKey" | "sessionId" | "agentId" | "lifecycleGeneration"
  >;
};

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
  const jobSessionBinding = params.admission.sessionBinding;
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
  const failureDisposition = classifyAcceptedChatSendFailure({
    error: params.error,
    phase: "pre-ack",
  });
  if (restartSafeAdmission) {
    const terminalized = await params
      .terminalizeRestartSafeAdmission({
        error: errorMessage,
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
    params.error instanceof SessionGoalOperationError
      ? errorShape(ErrorCodes.INVALID_REQUEST, params.error.message, {
          details: { code: "GOAL_OPERATION_REJECTED", reason: params.error.code },
        })
      : errorShape(
          ErrorCodes.UNAVAILABLE,
          errorMessage,
          failureDisposition === "client-retry"
            ? { retryable: true, retryAfterMs: 250 }
            : undefined,
        );
  const payload = { runId: clientRunId, status: "error" as const, summary: errorMessage };
  if (params.cacheResult !== false && failureDisposition !== "client-retry") {
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${clientRunId}`,
      session: captureAgentJobSession(jobSessionBinding),
      entry: { ts: Date.now(), ok: false, payload, error },
    });
  }
  params.respond(false, payload, error, { runId: clientRunId, error: formatForLog(params.error) });
  if (!hidden && failureDisposition !== "client-retry") {
    broadcastChatError({
      context: params.context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage,
    });
  }
}

/** Own dispatch settlement and post-cleanup lifecycle persistence. */
export function createChatSendDispatchErrorLifecycle(params: {
  admission: ChatSendJobAdmission & Pick<AdmittedChatSend, "activeRunAbort">;
  context: GatewayRequestContext;
  isAgentRunStarted: () => boolean;
  isQueuedFollowupEnqueued: () => boolean;
  isQueuedFollowupCompleted?: () => boolean;
  classifyFailure?: (error: unknown) => AcceptedChatSendFailureDisposition;
  isReplyDispatchRun?: () => boolean;
  persistUserTurnTranscript: () => Promise<unknown>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "now" | "rawSessionKey" | "sessionKey"
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
  const { agentId, backingSessionId, cfg, clientRunId, now, rawSessionKey, sessionKey } = session;
  const jobSessionBinding = admission.sessionBinding;
  // Cleanup releases the run context before delayed failure publication. Keep
  // the original projection policy so maintenance cannot become a visible turn.
  const visibility = getAgentRunContext(clientRunId);
  const hidden = visibility?.projectSessionMessages === false;
  const suppressLifecycle = visibility?.projectSessionLifecycle === false;
  let abortedDispatchMarker: ChatAbortMarker | undefined;
  let pendingDispatchLifecycleError: PendingDispatchLifecycleError | undefined;
  let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;
  let publishDispatchError: (() => void) | undefined;

  const handleError = async (err: unknown) => {
    const errorMessage = formatChatSendError(err);
    const failureDisposition =
      params.classifyFailure?.(err) ??
      classifyAcceptedChatSendFailure({ error: err, phase: "post-ack" });
    const queuedFollowupEnqueued = isQueuedFollowupEnqueued();
    if (queuedFollowupEnqueued) {
      context.logGateway.warn(
        `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
      );
      if (!context.chatRunState.hasAbortMarker(clientRunId)) {
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          session: captureAgentJobSession(jobSessionBinding),
          entry: {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: clientRunId,
              status: params.isQueuedFollowupCompleted?.() ? "completed" : "ok",
            },
          },
        });
        broadcastChatFinal({
          context,
          runId: clientRunId,
          sessionKey,
          agentId,
        });
      }
      return;
    }

    // Capture terminal ownership before durable cleanup yields: an explicit
    // abort has both its signal and canonical marker, but a restart may abort
    // only the signal and must retain its real dispatch-failure outcome.
    const abortedAtDispatchReject = activeRunAbort.controller.signal.aborted;
    const abortMarkerAtDispatchReject = context.chatRunState.runs.get(clientRunId)?.abortMarker;
    const agentTerminalPersistenceOwnedAtDispatchReject =
      activeRunAbort.entry?.projectSessionTerminalPending === true ||
      activeRunAbort.entry?.projectSessionTerminalPersistence !== undefined ||
      activeRunAbort.entry?.projectSessionTerminalPersisted === true;

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

    // Retire abortability before asynchronous terminal persistence. Otherwise
    // a later chat.abort can publish a second terminal for a rejected run.
    context.chatRunState.deleteAbortMarker(clientRunId);
    if (agentTerminalPersistenceOwnedAtDispatchReject && activeRunAbort.entry) {
      activeRunAbort.entry.isAbortable = () => false;
    }
    activeRunAbort.cleanup();

    let restartSafeDispatchFailureTerminalized = false;
    if (restartSafeAdmission && !agentTerminalPersistenceOwnedAtDispatchReject) {
      restartSafeDispatchFailureTerminalized = await terminalizeRestartSafeAdmission({
        error: errorMessage,
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
      !agentTerminalPersistenceOwnedAtDispatchReject
    ) {
      pendingDispatchLifecycleError = {
        endedAt: Date.now(),
        error: errorMessage,
        sessionId: activeRunAbort.entry?.sessionId ?? backingSessionId ?? clientRunId,
        startedAt: activeRunAbort.entry?.startedAtMs ?? now,
      };
    }
    if (!agentTerminalPersistenceOwnedAtDispatchReject || params.isReplyDispatchRun?.()) {
      // Native lifecycle owns its replay result; dispatched runtimes leave
      // failure projection to this owner, including transcript-write failures.
      const publish = () => {
        const error = errorShape(ErrorCodes.UNAVAILABLE, errorMessage);
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          session: captureAgentJobSession(jobSessionBinding),
          entry: {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: errorMessage,
            },
            error,
          },
        });
        if (!hidden) {
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            errorMessage,
          });
        }
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
    const dispatchError = pendingDispatchLifecycleError;
    // Commands and reply-dispatch runtimes have already published their terminal.
    // Native agent events keep ownership until their own terminal delivery completes.
    const clearRun = () => {
      if (!params.isAgentRunStarted() || params.isReplyDispatchRun?.()) {
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
        const endedAt = chatAbortMarkerTimestampMs(abortMarker);
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          session: captureAgentJobSession(jobSessionBinding),
          entry: {
            ts: endedAt,
            ok: true,
            payload: buildAbortedChatSendPayload({
              runId: clientRunId,
              stopReason: activeRunAbort.entry?.abortStopReason ?? "rpc",
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
        context,
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

  return { finalize, handleError };
}
