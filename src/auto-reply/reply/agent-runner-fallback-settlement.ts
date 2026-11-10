import { classifyAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { isContextOverflowError } from "../../agents/failover/context-overflow.js";
import {
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  renderControlUiAgentFailureCopy,
} from "../../agents/failover/user-copy.js";
import {
  isHostMissingReplyNoticeText,
  resolveReplyExpectation,
} from "../../agents/reply-completion.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import { resolveSourceReplyPolicy } from "./agent-runner-core.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import type { AgentFallbackCandidatesResult } from "./agent-runner-fallback-candidate.js";
import type {
  AgentFallbackCycleParams,
  AgentFallbackCycleResult,
} from "./agent-runner-fallback-cycle.types.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import { isStrandedPrivateMessageToolFinal } from "./private-message-tool-final.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";

/** Settles abort, lifecycle, and terminal failure state after fallback execution. */
export async function settleAgentFallbackCycle(params: {
  cycle: AgentFallbackCycleParams;
  fallbackResult: AgentFallbackCandidatesResult;
}): Promise<AgentFallbackCycleResult> {
  const { cycle, fallbackResult } = params;
  const turn = cycle.turn;
  const runResult = fallbackResult.result;
  const fallbackProvider = fallbackResult.provider;
  const fallbackModel = fallbackResult.model;
  const fallbackExhausted = fallbackResult.outcome === "exhausted";
  // run-entry owns the canonical reply/receipt facts. Carry them through the
  // fallback backstop so downstream waiters never have to rederive them.
  const terminalMetadata = fallbackResult.terminal.metadata;
  const terminalOutcome = fallbackResult.terminal.outcome;
  const settledLifecycleTerminal =
    cycle.state.pendingLifecycleTerminal?.provider === fallbackProvider &&
    cycle.state.pendingLifecycleTerminal.model === fallbackModel
      ? cycle.state.pendingLifecycleTerminal.backstop
      : undefined;
  cycle.state.pendingLifecycleTerminal = undefined;
  const abortReason = resolveReplyOperationAbortReason(turn.replyOperation);
  if (abortReason) {
    settledLifecycleTerminal?.emit("end", runResult, terminalMetadata);
    await drainPendingToolTasks({ tasks: turn.pendingToolTasks });
    return { kind: "aborted", reason: abortReason };
  }
  cycle.commitTerminalOutcome();
  const fallbackAttempts = fallbackResult.attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    error: attempt.error,
    reason: attempt.reason ?? "unknown",
    status: attempt.status,
    code: attempt.code || undefined,
  }));
  if (!fallbackExhausted) {
    await fallbackResult.settleSessionOverride();
  }
  const embeddedError = runResult.meta?.error;
  const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
  const userFacingErrorPayload = runResult.payloads?.find(
    (payload) => payload.isError === true && payload.text !== undefined,
  )?.text;
  const hostMissingReplyError = isHostMissingReplyNoticeText(embeddedError?.message)
    ? embeddedError?.message
    : undefined;
  // The timeout owner distinguishes its diagnostic from earlier tool failures.
  const terminalErrorMessage =
    deferredLifecycleError ??
    (terminalOutcome.status === "timeout" ? terminalOutcome.error : userFacingErrorPayload) ??
    hostMissingReplyError ??
    (embeddedError ? "Agent run failed" : undefined);
  const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
    if (settledLifecycleTerminal) {
      settledLifecycleTerminal.emit("error", error, extraData);
      return;
    }
    emitAgentEvent({
      runId: cycle.runId,
      lifecycleGeneration: cycle.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: {
        phase: "error",
        error: error.message,
        endedAt: Date.now(),
        ...extraData,
        executionSettled: true,
      },
    });
  };
  const isCompactionFailure = embeddedError && isContextOverflowError(embeddedError.message);
  if (isCompactionFailure || embeddedError?.kind === "role_ordering") {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    if (isCompactionFailure) {
      defaultRuntime.error(
        `Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${turn.sessionKey ?? turn.followupRun.run.sessionId}.`,
      );
    }
    turn.replyOperation?.fail("run_failed", embeddedError);
    const text = isCompactionFailure
      ? buildContextOverflowRecoveryText()
      : cycle.shouldSurfaceToControlUi
        ? renderControlUiAgentFailureCopy()
        : PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE;
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({ text }),
      postCompactionModelFailure: cycle.state.postCompactionModelAttempted || undefined,
    };
  }
  const sourceReplyPolicy = turn.sessionKey
    ? resolveSourceReplyPolicy({
        cfg: cycle.runtimeConfig,
        sessionCtx: turn.sessionCtx,
        sessionEntry: turn.getActiveSessionEntry(),
        sessionKey: turn.sessionKey,
        runtimePolicySessionKey: turn.runtimePolicySessionKey,
        opts: turn.opts,
      })
    : undefined;
  const successfulSourceReplyDelivery = hasCompletedSourceReplyDeliveryEvidence(runResult);
  const hasPendingContinuation =
    runResult.meta?.yielded === true ||
    runResult.meta?.continuationPending === true ||
    (runResult.meta?.pendingToolCalls?.length ?? 0) > 0;
  const privateFinalTerminalReply =
    !hasPendingContinuation &&
    isStrandedPrivateMessageToolFinal({
      replyExpectation: resolveReplyExpectation({
        ...turn.followupRun.run,
        scheduledAutomation: turn.followupRun.run.scheduledAutomation !== undefined,
      }),
      sourceReplyDeliveryMode: sourceReplyPolicy?.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy?.sendPolicyDenied === true,
      successfulSourceReplyDelivery,
      isRoomEvent: turn.sessionCtx.InboundEventKind === "room_event",
      terminalReply: runResult.meta?.terminalReply,
    })
      ? ({ disposition: "empty", code: "message-tool-not-called" } as const)
      : undefined;
  const terminalRunFailed =
    fallbackExhausted ||
    Boolean(
      deferredLifecycleError ||
      embeddedError ||
      terminalOutcome.status === "timeout" ||
      classifyAgentRunTerminalOutcome(terminalOutcome) === "failure",
    );
  if (terminalRunFailed) {
    const terminalError = new Error(
      terminalErrorMessage ??
        (fallbackExhausted ? "All model fallback candidates failed" : "Agent run failed"),
    );
    if (
      !fallbackExhausted ||
      cycle.modelPatch.captureFallbackFailure(fallbackAttempts) === undefined
    ) {
      cycle.modelPatch.captureFailure(embeddedError ?? terminalError);
    }
    emitSettledLifecycleError(terminalError, terminalMetadata);
    turn.replyOperation?.fail("run_failed", terminalError);
  } else {
    if (privateFinalTerminalReply) {
      runResult.meta.terminalReply = privateFinalTerminalReply;
    }
    settledLifecycleTerminal?.emit(
      "end",
      runResult,
      privateFinalTerminalReply
        ? { ...terminalMetadata, terminalReply: privateFinalTerminalReply }
        : terminalMetadata,
    );
  }
  return {
    kind: "completed",
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    terminalRunFailed,
  };
}
