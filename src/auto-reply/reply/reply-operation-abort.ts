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

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  return (
    (replyOperation?.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_by_user") ||
    resolveSignalAbortReason(replyOperation?.abortSignal) === "user"
  );
}

function hasReplyOperationAbort(
  replyOperation: ReplyOperation | undefined,
  code: "aborted_for_restart" | "aborted_for_supersession",
  matchesReason: (reason: unknown) => boolean,
): boolean {
  return (
    (replyOperation?.result?.kind === "aborted" && replyOperation.result.code === code) ||
    (replyOperation?.abortSignal?.aborted === true &&
      matchesReason(replyOperation.abortSignal.reason))
  );
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
  return hasReplyOperationAbort(
    replyOperation,
    "aborted_for_supersession",
    isAgentRunSupersededAbortReason,
  );
}

export function resolveReplyOperationAbortReason(
  replyOperation?: ReplyOperation,
  error?: unknown,
  signal: AbortSignal | undefined = replyOperation?.abortSignal,
): "user" | "restart" | "superseded" | undefined {
  // Operation-owned settlement precedes the caller signal, which precedes thrown markers.
  return hasReplyOperationAbort(replyOperation, "aborted_for_restart", isAgentRunRestartAbortReason)
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
