import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearAgentRunContext } from "../../infra/agent-events.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { chatAbortMarkerTimestampMs } from "../server-chat-state.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

type PendingDispatchLifecycleError = {
  endedAt: number;
  error: string;
  sessionId: string;
  startedAt: number;
};

/** Own dispatch rejection projection and post-cleanup lifecycle persistence. */
export function createChatSendDispatchErrorLifecycle(params: {
  admission: Pick<
    AdmittedChatSend,
    "activeRunAbort" | "cleanupAdmittedRun" | "lifecycleGeneration" | "restartSafeAdmission"
  >;
  context: GatewayRequestContext;
  isQueuedFollowupEnqueued: () => boolean;
  persistUserTurnTranscript: () => Promise<unknown>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "now" | "rawSessionKey" | "sessionKey"
  >;
  terminalizeRestartSafeAdmission: (state: {
    retryable: boolean;
    status: "failed" | "killed";
  }) => Promise<boolean>;
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
  let pendingDispatchLifecycleError: PendingDispatchLifecycleError | undefined;
  let persistDispatchErrorUserTurn: (() => Promise<void>) | undefined;

  const handleError = async (err: unknown) => {
    const errorMessage = String(err);
    const queuedFollowupEnqueued = isQueuedFollowupEnqueued();
    if (queuedFollowupEnqueued) {
      context.logGateway.warn(
        `webchat dispatch failed after followup queue admission: ${formatForLog(err)}`,
      );
      if (!context.chatAbortedRuns.has(clientRunId)) {
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${clientRunId}`,
          entry: {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
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

    // Select terminal ownership before any awaited durable-state work. An
    // explicit abort has both the signal and marker; restart interruption
    // only aborts the signal and must still follow dispatch-error handling.
    const abortedAtDispatchReject = activeRunAbort.controller.signal.aborted;
    const abortMarkerAtDispatchReject = context.chatAbortedRuns.get(clientRunId);
    const abortStopReasonAtDispatchReject = activeRunAbort.entry?.abortStopReason ?? "rpc";
    const persistAbortTranscript = async () => {
      if (userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()) {
        return;
      }
      await persistUserTurnTranscript().catch((transcriptErr: unknown) => {
        context.logGateway.warn(
          `webchat user transcript update failed after abort: ${formatForLog(transcriptErr)}`,
        );
      });
    };
    if (abortedAtDispatchReject && abortMarkerAtDispatchReject !== undefined) {
      if (restartSafeAdmission) {
        await terminalizeRestartSafeAdmission({
          retryable: false,
          status: "killed",
        }).catch((terminalizeError: unknown) => {
          context.logGateway.warn(
            `failed to terminalize restart-safe chat admission after abort: ${formatForLog(
              terminalizeError,
            )}`,
          );
          return false;
        });
      }
      const endedAt = chatAbortMarkerTimestampMs(abortMarkerAtDispatchReject);
      const payload = buildAbortedChatSendPayload({
        runId: clientRunId,
        stopReason: abortStopReasonAtDispatchReject,
        endedAt,
      });
      context.logGateway.warn(
        `chat.send post-dispatch threw after abort for runId=${clientRunId}: ${formatForLog(err)}`,
      );
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: endedAt,
          ok: true,
          payload,
        },
      });
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      await persistAbortTranscript();
      return;
    }

    // Dispatch rejection owns every remaining path. Retire abortability
    // synchronously before durable terminalization can suspend, so a late
    // chat.abort cannot publish or cache a contradictory terminal state.
    context.chatAbortedRuns.delete(clientRunId);
    activeRunAbort.cleanup({ force: true });

    let restartSafeDispatchFailureTerminalized = false;
    if (restartSafeAdmission) {
      restartSafeDispatchFailureTerminalized = await terminalizeRestartSafeAdmission({
        retryable: true,
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
    if (!restartSafeDispatchFailureTerminalized && abortMarkerAtDispatchReject === undefined) {
      pendingDispatchLifecycleError = {
        endedAt: Date.now(),
        error: errorMessage,
        sessionId: activeRunAbort.entry?.sessionId ?? backingSessionId ?? clientRunId,
        startedAt: activeRunAbort.entry?.startedAtMs ?? now,
      };
    }
    const error = errorShape(ErrorCodes.UNAVAILABLE, errorMessage);
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
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
    broadcastChatError({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage,
    });
  };
  const finalize = () => {
    const dispatchError = pendingDispatchLifecycleError;
    // Reserve projection before cleanup retires the accepted dispatch root.
    const releaseDispatchErrorRoot = dispatchError
      ? retainGatewayRootWorkAdmissionContinuation()
      : null;
    cleanupAdmittedRun();
    clearAgentRunContext(clientRunId, lifecycleGeneration);
    context.removeChatRun(clientRunId, clientRunId, sessionKey);
    if (!dispatchError) {
      return;
    }
    const persistDispatchLifecycleError = async () => {
      const hasActiveRun = hasTrackedActiveSessionRun({
        context,
        requestedKey: rawSessionKey,
        canonicalKey: sessionKey,
        ...(sessionKey === "global" && agentId ? { agentId } : {}),
        defaultAgentId: resolveDefaultAgentId(cfg),
      });
      if (hasActiveRun) {
        return;
      }
      try {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          ...(sessionKey === "global" && agentId ? { agentId } : {}),
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
    };
    void (async () => {
      await persistDispatchLifecycleError();
      await persistDispatchErrorUserTurn?.().catch((transcriptErr: unknown) => {
        context.logGateway.warn(
          `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
        );
      });
    })()
      .catch((continuationErr: unknown) => {
        context.logGateway.warn(
          `webchat session lifecycle continuation failed: ${formatForLog(continuationErr)}`,
        );
      })
      .finally(() => releaseDispatchErrorRoot?.());
  };

  return { finalize, handleError };
}
