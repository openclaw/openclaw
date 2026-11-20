import { setTimeout as delay } from "node:timers/promises";
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
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { claimSystemEventTurn } from "../../infra/system-events.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";

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
        ...(failed && result.code === "run_stalled" ? { status: "timeout" } : {}),
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

function readmitSessionEventOccurrence(params: {
  text: string;
  options: SessionEventOptions &
    Required<Pick<SessionEventOptions, "agentId" | "sessionKey" | "occurrences">>;
  attempt: number;
  adopted: boolean;
  occurrenceId: string;
  enqueue: (text: string, options: SessionEventOptions, attempt: number) => SessionEventReceipt;
  log: Pick<SubsystemLogger, "error">;
}): { receipt?: SessionEventReceipt; failure?: Error | string } {
  const { options } = params;
  // These fresh readmission options retain passive custody only until adoption.
  options.preserveOccurrenceOnRejection =
    options.preserveOccurrenceOnRejection && !params.adopted ? true : undefined;
  try {
    return { receipt: params.enqueue(params.text, options, params.attempt) };
  } catch (error) {
    if (!options.preserveOccurrenceOnRejection) {
      // A released occurrence without a producer contract must be consumed.
      claimSystemEventTurn(
        resolveSystemEventQueueKey(options.sessionKey, options.agentId),
        options.occurrences,
        () => {},
        options.agentId,
      )?.cancel();
    }
    const failure = error instanceof Error ? error : String(error);
    params.log.error("session event policy readmission rejected", {
      source: options.source,
      agentId: options.agentId,
      sessionKey: options.sessionKey,
      eventId: params.occurrenceId,
      error: String(failure),
    });
    return { failure };
  }
}

/** A policy or provider wait can retain only an occurrence that has done no work. */
type SessionEventTerminal = ReturnType<typeof resolveSessionEventTerminalOutcome>;

export async function settleSessionEventAttempt(params: {
  text: string;
  options: SessionEventOptions &
    Required<Pick<SessionEventOptions, "agentId" | "sessionKey" | "occurrences">>;
  signal: AbortSignal;
  adopted: boolean;
  occurrenceId: string;
  ownership: { release: () => void; cancel: () => void };
  dispatchAttempt: number;
  configReadmissions: number;
  canResume: () => boolean;
  canRetryConfig: () => boolean;
  waitingProvider?: string;
  onSettling: (error?: Error | string) => SessionEventTerminal;
  preserveOccurrence: boolean;
  enqueue: (
    text: string,
    options: SessionEventOptions,
    attempt: number,
    configReadmissions: number,
  ) => SessionEventReceipt;
  log: Pick<SubsystemLogger, "error">;
}): Promise<{
  terminal: SessionEventTerminal;
  receipt?: SessionEventReceipt;
  failure?: Error | string;
}> {
  const { signal, ownership, options } = params;
  const finish = (terminal: SessionEventTerminal) => {
    if (terminal.status === "failed") {
      params.log.error("session event execution failed", {
        source: options.source,
        agentId: options.agentId,
        sessionKey: options.sessionKey,
        eventId: params.occurrenceId,
        error: String(terminal.failure),
      });
    }
    return { terminal };
  };
  const retryConfig = () => params.canResume() && params.canRetryConfig();
  if (retryConfig()) {
    await delay(100 * 2 ** params.configReadmissions, undefined, { signal }).catch(
      (error: unknown) => {
        if (!signal.aborted) {
          throw error;
        }
      },
    );
  }
  const config = retryConfig();
  const provider = !config && params.canResume() ? params.waitingProvider : undefined;
  const terminal = params.onSettling();
  if (provider !== undefined) {
    // The reply owner has settled. Keep the event claimed while other turns use the session.
    try {
      await options.scheduledAutomation?.providerRunSlot?.wait(provider, signal);
    } catch (error) {
      const stopped = params.onSettling(error instanceof Error ? error : String(error));
      ownership.cancel();
      return finish(stopped);
    }
  }
  if (config || provider !== undefined) {
    ownership.release();
    const readmitted = readmitSessionEventOccurrence({
      text: params.text,
      options,
      attempt: params.dispatchAttempt + 1,
      occurrenceId: params.occurrenceId,
      adopted: params.adopted,
      enqueue: (text, nextOptions, attempt) =>
        params.enqueue(text, nextOptions, attempt, params.configReadmissions + (config ? 1 : 0)),
      log: params.log,
    });
    return {
      ...readmitted,
      terminal:
        provider !== undefined && readmitted.failure !== undefined
          ? params.onSettling(readmitted.failure)
          : terminal,
    };
  }
  if (params.preserveOccurrence) {
    ownership.release();
  } else {
    ownership.cancel();
  }
  return finish(terminal);
}
