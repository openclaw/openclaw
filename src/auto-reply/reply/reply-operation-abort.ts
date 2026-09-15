import { isFallbackSummaryError } from "../../agents/model-fallback-attempt.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime.errors.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export function buildRestartLifecycleReplyText(): string {
  return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_by_user"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return (
    abortSignal?.aborted === true &&
    !isAgentRunRestartAbortReason(abortSignal.reason) &&
    !isAgentRunSupersededAbortReason(abortSignal.reason)
  );
}

function isReplyOperationRestartAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && isAgentRunRestartAbortReason(abortSignal.reason);
}

export function resolveReplyOperationTerminationFields(
  error: unknown,
  signal: AbortSignal | undefined,
  replyOperation?: ReplyOperation,
) {
  return {
    ...resolveAgentRunErrorLifecycleFields(error, signal),
    ...(isReplyOperationRestartAbort(replyOperation)
      ? { aborted: true as const, stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON }
      : {}),
  };
}

export function isReplyOperationSuperseded(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_supersession"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && isAgentRunSupersededAbortReason(abortSignal.reason);
}

export function resolveReplyOperationAbortReason(
  replyOperation?: ReplyOperation,
  error?: unknown,
): "user" | "restart" | "superseded" | undefined {
  return isAgentRunRestartAbortReason(error) || isReplyOperationRestartAbort(replyOperation)
    ? "restart"
    : isReplyOperationSuperseded(replyOperation) || isPreparedModelRuntimeSupersessionError(error)
      ? "superseded"
      : isAgentRunDirectAbortReason(error) || isReplyOperationUserAbort(replyOperation)
        ? "user"
        : undefined;
}

export function resolveRestartLifecycleError(
  error: unknown,
): GatewayDrainingError | CommandLaneClearedError | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const candidate of pending) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (candidate instanceof GatewayDrainingError || candidate instanceof CommandLaneClearedError) {
      return candidate;
    }
    if (isFallbackSummaryError(candidate)) {
      pending.push(...candidate.attempts.map((attempt) => attempt.error));
    }
    if (candidate instanceof Error && "cause" in candidate) {
      pending.push(candidate.cause);
    }
  }
  return undefined;
}

/**
 * True when a thrown reply-operation error is (or wraps) a prepared-model-runtime
 * generation supersession — the benign TOCTOU race where `main` re-prepares its
 * runtime and bumps the published owner generation after the heartbeat run passed
 * its point-in-time idle guards but before the model turn acquired that owner.
 *
 * This surfaces as a thrown `PreparedModelRuntimeOwnerNotPublishedError` fast-failing
 * every model-fallback candidate, not as an abort-signal supersession, so
 * `isReplyOperationSuperseded` (abort-signal based) does not catch it. Walking the
 * fallback-summary attempts and error causes lets callers classify it as a
 * preemption skip instead of a genuine agent-runner failure, while any other thrown
 * error stays a real, visible failure.
 */
export function isPreparedModelRuntimeSupersessionError(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const candidate of pending) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (candidate instanceof PreparedModelRuntimeOwnerNotPublishedError) {
      return true;
    }
    if (isFallbackSummaryError(candidate)) {
      pending.push(...candidate.attempts.map((attempt) => attempt.error));
    }
    if (candidate instanceof Error && "cause" in candidate) {
      pending.push(candidate.cause);
    }
  }
  return false;
}
