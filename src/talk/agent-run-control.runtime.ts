import {
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  getActiveNativeAttempt,
  getControllerEmbeddedAttachment,
} from "../agents/embedded-agent-runner/run-state.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../agents/embedded-agent-runner/runs.js";
import { getRuntimeConfig } from "../config/config.js";
import { abortControlledSubagents } from "../gateway/server-methods/chat-abort-descendants.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import { resolveActiveReplyRunOwnerForSignal } from "../sessions/session-controller.barriers.js";
import type {
  ReplyMessageInjectionOptions,
  ReplyOperation,
} from "../sessions/session-controller.contracts.js";
import {
  resolveActiveReplyOperationForSessionId,
  resolveActiveSessionRunId,
} from "../sessions/session-controller.queries.js";
import { getRpcSourceForSignal } from "../sessions/session-controller.rpc-sources.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
  operationsByUpstreamAbortSignal,
} from "../sessions/session-controller.state.js";
import { steerSessionControllerOperation } from "../sessions/session-controller.steer.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";

/** Signal-owned sources stay exact; external callers retain native run-ID selection. */
function resolveSourceRunOwner(runId: string, signal: AbortSignal) {
  if (signal.aborted) {
    return undefined;
  }
  const input = getRpcSourceForSignal(runId, signal)?.input;
  const operation = input
    ? input.claim?.released
      ? undefined
      : input.claim?.operation
    : operationsByUpstreamAbortSignal.get(signal);
  if (!input && !operation) {
    const native = resolveActiveEmbeddedRunOwnerByRunId(runId);
    return native
      ? { ...native, operation: ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId.trim())?.operation }
      : undefined;
  }
  if (!operation || operation.result || !isCurrentSessionControllerOperation(operation)) {
    return undefined;
  }
  const registration = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId.trim());
  if (registration && registration.operation !== operation) {
    return undefined;
  }
  const native = resolveActiveEmbeddedRunOwnerByRunId(runId);
  const owner =
    native ??
    (getControllerEmbeddedAttachment(operation)
      ? undefined
      : resolveActiveReplyRunOwnerForSignal(operation.abortSignal));
  return owner ? { ...owner, operation } : undefined;
}

/**
 * Key-only Talk cancel: Stop source `talk` aborts the session's current turn and
 * that turn's subagents, and keeps the session's waiting inputs.
 */
async function stopRealtimeVoiceSessionRun(params: {
  sessionKey: string;
  sessionId: string;
}): Promise<boolean> {
  const operation = resolveActiveReplyOperationForSessionId(params.sessionId);
  if (!operation || operation.key !== params.sessionKey) {
    return false;
  }
  const entry = getSessionControllerEntryForOperation(operation);
  // Capture this exact turn and its claimed inputs before Stop can yield.
  const capture = captureSessionControllerStop({
    inputs: entry.mailbox?.entries.filter((input) => input.claim?.operation === operation),
    operations: [operation],
  });
  const turnRunId = getActiveNativeAttempt(params.sessionId)?.runId;
  const outcome = await stopSession({
    source: "talk",
    capture,
    hookContext: { ...params, commandSource: "talk" },
    stopChildren: async (applyParentStop) => {
      if (!turnRunId) {
        await applyParentStop();
        return { stopped: 0, failed: 0 };
      }
      const descendants = await abortControlledSubagents({
        cfg: getRuntimeConfig(),
        sessionKey: params.sessionKey,
        agentId: operation.agentId,
        requesterTurnRunId: turnRunId,
        beforeKill: applyParentStop,
      });
      return {
        stopped: descendants?.killed ?? 0,
        failed: descendants?.status === "error" ? descendants.failed : 0,
      };
    },
  }).completed;
  return outcome.aborted;
}

export const realtimeVoiceControlRuntime = {
  stopRealtimeVoiceSessionRun,
  steerActiveRun: (
    operation: ReplyOperation | undefined,
    text: string,
    options: ReplyMessageInjectionOptions,
  ) =>
    steerSessionControllerOperation({
      operation,
      text,
      options,
      // A spoken steer reports an unconfirmed receipt instead of cancelling the turn.
      abortOnUnconfirmedTranscript: false,
    }),
  resolveSourceRunOwner,
  resolveActiveSessionRunId,
  getDiagnosticSessionActivitySnapshot,
};
