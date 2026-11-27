import { setTimeout as delay } from "node:timers/promises";
import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { FAILOVER_REASONS } from "../../agents/failover/signal.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { isWorkspaceAccessUnavailableError } from "../../agents/workspace-access.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { claimSystemEventTurn } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
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

// A dedicated workspace node reconnects a few seconds after a Gateway restart.
const RESTART_WORKSPACE_RECONNECT_WINDOW_MS = 60_000;
const RESTART_WORKSPACE_RECONNECT_POLL_MS = 1_000;

/** Re-admission state of one occurrence; config and reconnect retries keep separate budgets. */
export type SessionEventReadmission = {
  attempt: number;
  configAttempt: number;
  reconnectDeadline: number;
};

export function createSessionEventReadmission(): SessionEventReadmission {
  return {
    attempt: 0,
    configAttempt: 0,
    reconnectDeadline: Date.now() + RESTART_WORKSPACE_RECONNECT_WINDOW_MS,
  };
}

type SessionEventReadmissionFacts = {
  source: SessionEventOptions["source"];
  failure: unknown;
  configPolicy: { readonly changed: boolean; canReadmit(attempt: number): boolean };
  /** False when cancelling the staged input failed; such an occurrence is never retried. */
  inputSettled: boolean;
  accepted: boolean;
  adopted: boolean;
  started: boolean;
  conversationResultCommitted?: true;
  delivery: { delivered: boolean; deliveryAttempted: boolean; deliveryAmbiguous: boolean };
  abandoned: boolean;
};

/** Only a node.invoke refused before dispatch proves a retry cannot repeat an effect. */
function isUndispatchedWorkspaceDisconnect(error: unknown): boolean {
  return (
    isWorkspaceAccessUnavailableError(error) &&
    collectErrorGraphCandidates(error, (current) => [current.cause]).some((candidate) => {
      const details = asNullableRecord(asNullableRecord(candidate)?.details);
      return (
        asNullableRecord(details?.nodeError)?.code === "NOT_CONNECTED" &&
        details?.nodeCommandDispatched === false
      );
    })
  );
}

function resolveSessionEventReadmissionKind(
  readmission: SessionEventReadmission,
  facts: SessionEventReadmissionFacts,
  signal: AbortSignal,
): "config" | "reconnect" | undefined {
  if (facts.started || facts.delivery.deliveryAttempted || signal.aborted || facts.abandoned) {
    return undefined;
  }
  // A policy publication that rejected an unstarted occurrence re-admits it under the
  // current policy instead of destroying it.
  if (facts.configPolicy.changed && facts.configPolicy.canReadmit(readmission.configAttempt)) {
    return "config";
  }
  // A restart input that reached its workspace node before the node reconnected was
  // never dispatched. Anything that may have had effects stays terminal.
  const untouched =
    facts.inputSettled &&
    !facts.accepted &&
    !facts.adopted &&
    !facts.conversationResultCommitted &&
    !facts.delivery.delivered &&
    !facts.delivery.deliveryAmbiguous;
  return untouched &&
    facts.source === "restart" &&
    Date.now() < readmission.reconnectDeadline &&
    isUndispatchedWorkspaceDisconnect(facts.failure)
    ? "reconnect"
    : undefined;
}

/** Wait before fresh authority, then return the next attempt's state if it may still run. */
export async function prepareSessionEventReadmission(
  readmission: SessionEventReadmission,
  signal: AbortSignal,
  facts: () => SessionEventReadmissionFacts,
): Promise<SessionEventReadmission | undefined> {
  const pending = resolveSessionEventReadmissionKind(readmission, facts(), signal);
  if (!pending) {
    return undefined;
  }
  const delayMs =
    pending === "config"
      ? 100 * 2 ** readmission.configAttempt
      : RESTART_WORKSPACE_RECONNECT_POLL_MS;
  // Cancellation can end retention during the wait.
  await delay(delayMs, undefined, { signal }).catch((error: unknown) => {
    if (!signal.aborted) {
      throw error;
    }
  });
  const kind = resolveSessionEventReadmissionKind(readmission, facts(), signal);
  return kind
    ? {
        ...readmission,
        attempt: readmission.attempt + 1,
        configAttempt: readmission.configAttempt + (kind === "config" ? 1 : 0),
      }
    : undefined;
}

export function resolveSessionEventTerminalErrorReason(
  data: Record<string, unknown>,
): SessionEventOutcome["errorReason"] {
  const observation = data.errorObservation;
  return data.phase === "error" && isRecord(observation)
    ? FAILOVER_REASONS.find((reason) => reason === observation.failoverReason)
    : undefined;
}

export function readmitSessionEventOccurrence(params: {
  ownership: { release: () => unknown };
  options: SessionEventOptions;
  adopted: boolean;
  text: string;
  occurrenceId: string;
  assertAcceptanceCurrent?: SessionEventOptions["assertAcceptanceCurrent"];
  nextReadmission: SessionEventReadmission;
  sessionKey: string;
  agentId: string;
  occurrences: Parameters<typeof claimSystemEventTurn>[1];
  failure?: Error | string;
  retry: (
    text: string,
    options: SessionEventOptions,
    readmission: SessionEventReadmission,
  ) => SessionEventReceipt;
}): { readmittedReceipt?: SessionEventReceipt; failure?: Error | string } {
  const { ownership, options, sessionKey, agentId, occurrences } = params;
  // Passive custody survives only until some attempt adopts the occurrence.
  const preservePassive =
    options.preserveOccurrenceOnRejection && !params.adopted ? true : undefined;
  ownership.release();
  try {
    // Re-admit under current policy and preserve only explicitly passive custody.
    return {
      readmittedReceipt: params.retry(
        params.text,
        {
          ...options,
          agentId,
          sessionKey,
          occurrences,
          assertAcceptanceCurrent: params.assertAcceptanceCurrent,
          preserveOccurrenceOnRejection: preservePassive,
        },
        params.nextReadmission,
      ),
      failure: params.failure,
    };
  } catch (error) {
    if (!preservePassive) {
      // The released occurrence carries no producer contract; consume it.
      claimSystemEventTurn(
        resolveSystemEventQueueKey(sessionKey, agentId),
        occurrences,
        () => {},
        agentId,
      )?.cancel();
    }
    const failure = error instanceof Error ? error : String(error);
    createSubsystemLogger("session-events").error("session event policy readmission rejected", {
      source: options.source,
      agentId,
      sessionKey,
      eventId: params.occurrenceId,
      error: String(failure),
    });
    return { failure };
  }
}
