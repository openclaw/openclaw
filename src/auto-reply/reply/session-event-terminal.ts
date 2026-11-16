import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { SessionEventOutcome } from "./session-event-contract.js";

/** Reconcile settled controller facts without changing event custody or retry policy. */
export function resolveSessionEventTerminalOutcome(params: {
  operation?: Pick<ReplyOperation, "result" | "abortSignal">;
  signal: AbortSignal;
  failure?: Error | string;
  genericFailure?: string;
  terminalOutcome?: AgentRunTerminalOutcome;
}): {
  failure: Error | string | undefined;
  terminalOutcome: AgentRunTerminalOutcome;
  status: SessionEventOutcome["status"];
} {
  const { operation, signal, genericFailure } = params;
  let { failure, terminalOutcome } = params;
  const result = operation?.result;
  const failed = result?.kind === "failed";
  const aborted = result?.kind === "aborted";
  const terminalSignal = operation?.abortSignal.aborted ? operation.abortSignal : signal;
  const cause = failed ? result.cause : undefined;
  const terminalError = cause ?? failure;
  if (!failure && cause !== undefined) {
    failure = cause instanceof Error ? cause : formatErrorMessage(cause);
  }
  failure ??= genericFailure;
  // Frozen supersession records cancellation without aborting its signal.
  // Watchdog failures may abort the backend without being cancellation;
  // retain typed deadline facts ahead of the recorded cancellation defaults.
  terminalOutcome = mergeAgentRunTerminalOutcome(
    terminalOutcome,
    buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: failed || aborted || failure ? "error" : "end",
      data: {
        ...(aborted ? { aborted: true } : {}),
        ...(aborted && result.code === "aborted_for_supersession"
          ? { stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON }
          : {}),
        ...resolveAgentRunErrorLifecycleFields(
          terminalError ?? terminalSignal.reason,
          failed ? undefined : terminalSignal,
        ),
        ...resolveAgentRunErrorLifecycleFields(terminalError ?? terminalSignal.reason, undefined),
        error: terminalError,
      },
      abortSignal: failed ? undefined : terminalSignal,
    }),
  );
  const classification = classifyAgentRunTerminalOutcome(terminalOutcome);
  const status =
    classification === "cancellation"
      ? "cancelled"
      : classification === "success"
        ? "completed"
        : "failed";
  return { failure, terminalOutcome, status };
}
