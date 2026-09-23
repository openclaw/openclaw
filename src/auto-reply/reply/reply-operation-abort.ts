import { isFallbackSummaryError } from "../../agents/model-fallback-attempt.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  isSessionPlacementSettlementClosedError,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export function buildRestartLifecycleReplyText(): string {
  return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}

function resolveSignalAbortReason(
  signal: AbortSignal | undefined,
): "user" | "restart" | "superseded" | undefined {
  const stopReason = resolveAgentRunAbortLifecycleFields(signal).stopReason;
  if (stopReason === "restart" || stopReason === "superseded") {
    return stopReason;
  }
  return stopReason && !isSessionPlacementSettlementClosedError(signal?.reason)
    ? "user"
    : undefined;
}

function isUserAbortSignal(signal: AbortSignal | undefined): boolean {
  return resolveSignalAbortReason(signal) === "user";
}

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  return (
    (replyOperation?.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_by_user") ||
    isUserAbortSignal(replyOperation?.abortSignal)
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
  const ownerReason = resolveReplyOperationAbortReason(replyOperation);
  return {
    ...resolveAgentRunErrorLifecycleFields(error, signal),
    ...(ownerReason === "restart" || ownerReason === "superseded"
      ? { aborted: true as const, stopReason: ownerReason }
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
  signal: AbortSignal | undefined = replyOperation?.abortSignal,
): "user" | "restart" | "superseded" | undefined {
  // Operation-owned settlement precedes the caller signal, which precedes thrown markers.
  return isReplyOperationRestartAbort(replyOperation)
    ? "restart"
    : isReplyOperationSuperseded(replyOperation)
      ? "superseded"
      : (resolveSignalAbortReason(signal) ??
        (isAgentRunRestartAbortReason(error)
          ? "restart"
          : isAgentRunSupersededAbortReason(error)
            ? "superseded"
            : isAgentRunDirectAbortReason(error) || isReplyOperationUserAbort(replyOperation)
              ? "user"
              : undefined));
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
