import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-error.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { resolveAgentRunErrorLifecycleFields } from "../agents/run-termination.js";
import { resolveSessionEventTerminalOutcome } from "../auto-reply/reply/session-event-terminal.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import type { CronRunErrorClassification } from "./types.js";

/** Reconcile a run result or thrown failure with controller-owned terminal facts. */
export function resolveCronAgentTerminalOutcome(params: {
  phase: "end" | "error";
  data?: Parameters<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[0]["data"];
  error?: unknown;
  operation?: Pick<ReplyOperation, "result" | "abortSignal">;
  signal: AbortSignal;
}): AgentRunTerminalOutcome {
  const terminalOutcome =
    findAgentRunTerminalOutcome(params.error) ??
    buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: params.phase,
      data: {
        ...params.data,
        ...resolveAgentRunErrorLifecycleFields(
          params.error,
          params.operation?.abortSignal ?? params.signal,
        ),
      },
    });
  return params.operation?.result
    ? resolveSessionEventTerminalOutcome({
        operation: params.operation,
        signal: params.signal,
        terminalOutcome,
      }).terminalOutcome
    : terminalOutcome;
}

/** Cron policy consumes settled run facts; display text cannot turn them into retries. */
export function resolveCronAgentErrorClassification(
  terminal: AgentRunTerminalOutcome,
  reason?: FailoverReason,
  /** An owned setup refusal applies only to failures, never cancellation or timeout. */
  failureClassification?: CronRunErrorClassification,
): CronRunErrorClassification | undefined {
  if (terminal.stopReason === "auth-revoked" && terminal.reason !== "hard_timeout") {
    return { kind: "reason", reason: "auth_permanent" };
  }
  switch (terminal.reason) {
    case "completed":
      return undefined;
    case "hard_timeout":
    case "timed_out":
    case "aborted":
      return { kind: "reason", reason: "timeout" };
    case "cancelled":
    case "superseded":
      return { kind: "aborted" };
    case "blocked":
    case "abandoned":
    case "failed":
      // An unknown run failure does not invalidate the automation's operator source.
      return failureClassification ?? { kind: "reason", reason: reason ?? "unknown" };
  }
  return terminal.reason satisfies never;
}

/** Resolve one cron-owned classification before falling back to provider error inference. */
export function resolveCronRunErrorReason(
  error: unknown,
  provider?: string,
  classification?: CronRunErrorClassification,
): FailoverReason | undefined {
  if (classification && classification.kind !== "reason") {
    return undefined;
  }
  if (classification?.kind === "reason") {
    return classification.reason;
  }
  // Text-only failures without a model provider have no provider provenance.
  // In particular, heartbeat delivery errors can contain generic HTTP 5xx
  // wording that the model failover classifier would otherwise call a timeout.
  if (!provider?.trim()) {
    return undefined;
  }
  return resolveFailoverReasonFromError(error, provider) ?? undefined;
}
