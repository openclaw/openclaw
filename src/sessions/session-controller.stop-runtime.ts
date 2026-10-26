import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunInterruptTargetOperation,
  type ReplyBackendHandle,
  type ReplyOperation,
  type ReplyRunInterruptTarget,
  type SessionControllerInput,
} from "./session-controller.contracts.js";
import { resolveActiveReplyOperationForSessionId } from "./session-controller.queries.js";
import { waitForReplyOperationOwnerSettlement } from "./session-controller.settlement.js";
import {
  activeSessionOperations,
  getAttachedBackend,
  getSessionControllerOperation,
  isReplyOperationPreBackendPhase,
  isReplyRunCompacting,
} from "./session-controller.state.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionControllerStopCapture,
} from "./session-controller.stop.js";

/** Captures an active owner, or earlier admissions, without selecting this input or successors. */
export function captureSessionControllerInterruptBefore(
  input: SessionControllerInput,
): SessionControllerStopCapture | undefined {
  const scoped = captureSessionControllerStop(
    input.target
      ? { targets: [input.target] }
      : { inputs: input.mailbox.entries, operations: [input.mailbox.owner.active] },
  );
  const operations = new Set(
    scoped.operations.filter((operation) => operation !== input.claim?.operation),
  );
  for (const selected of scoped.activeInputs) {
    if (selected !== input && selected.claim?.operation) {
      operations.add(selected.claim.operation);
    }
  }
  if (operations.size) {
    // An existing producer may refuse cancellation while finalizing; do not cancel its queue.
    return captureSessionControllerStop({ operations });
  }
  const inputs = scoped.inputs.filter(
    (selected) => selected.mailbox === input.mailbox && selected.sequence < input.sequence,
  );
  return inputs.length ? captureSessionControllerStop({ inputs }) : undefined;
}

/** @internal Captures the current direct owner for exact-instance interruption; unit tests only. */
export function captureCurrentSessionRunInterruptTarget(
  sessionKey: string,
): ReplyRunInterruptTarget | undefined {
  const operation = getSessionControllerOperation(sessionKey);
  return operation ? { [replyRunInterruptTargetOperation]: operation } : undefined;
}

/** Abort the captured operation; null skips settlement for source acknowledgements. */
export async function interruptReplyRunTarget(
  target: ReplyRunInterruptTarget,
  timeoutMs: number | null = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): Promise<{ aborted: boolean; settled: boolean }> {
  const operation = target[replyRunInterruptTargetOperation];
  const stopped = stopSession({
    source: "interrupt",
    capture: captureSessionControllerStop({ operations: [operation] }),
    // The controller result distinguishes a committed abort from an observer failure.
    onError: () => "continue",
  });
  const aborted = stopped.aborted;
  const settled =
    timeoutMs === null ? false : await waitForReplyOperationOwnerSettlement(operation, timeoutMs);
  return { aborted, settled };
}

/** Cancels the current reply backend only when its native run identity matches exactly. */
export function supersedeReplyRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const expectedRunId = normalizeOptionalString(runId);
  if (!expectedRunId) {
    return false;
  }
  for (const operation of activeSessionOperations()) {
    const backend = getAttachedBackend(operation);
    if (normalizeOptionalString(backend?.runId) !== expectedRunId) {
      continue;
    }
    if (hasReplyBackendStopped(expectedRunId, backend)) {
      // A backend that already ended its turn keeps its own terminal outcome.
      return false;
    }
    return stopSession({
      source: "supersede",
      capture: captureSessionControllerStop({ operations: [operation] }),
      // Supersession preserves the selected operation’s finalization semantics.
      cancelOperation: (selected) => selected.supersede(beforeCancel),
    }).aborted;
  }
  return false;
}

/** A throwing lifecycle probe cannot prove live work, so it counts as stopped. */
function hasReplyBackendStopped(runId: string, backend: ReplyBackendHandle | undefined): boolean {
  try {
    return backend?.isStopped?.() === true || backend?.isAborted?.() === true;
  } catch (err) {
    diag.warn(`supersede failed: runId=${runId} reason=lifecycle_check_failed err=${String(err)}`);
    return true;
  }
}

/** @internal Exposed for unit tests only. */
export function clearReplyRunForResetBySessionId(sessionId: string): void {
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  if (!operation || isReplyOperationPreBackendPhase(operation.phase)) {
    return;
  }
  // Reset requests cancellation; only the captured producer can certify its return.
  operation.abortForRestart();
}

export function abortActiveReplyRuns(opts: {
  mode: "all" | "compacting";
  onAbortError?: (sessionId: string, error: unknown) => void;
}): boolean {
  const capture = captureSessionControllerStop({
    operations: [...activeSessionOperations()].filter(
      (operation) => opts.mode === "all" || isReplyRunCompacting(operation),
    ),
  });
  return (
    stopSession({
      capture,
      source: "restart",
      onError: (target, error) => {
        if ("sessionId" in target) {
          opts.onAbortError?.(target.sessionId, error);
        }
        return "continue";
      },
    }).activeCancelled > 0
  );
}

/** Stops one admitted operation for Gateway restart drain; its result records `aborted_for_restart`. */
export function stopReplyOperationForRestart(operation: ReplyOperation): boolean {
  return (
    stopSession({
      source: "restart",
      capture: captureSessionControllerStop({ operations: [operation] }),
      onError: () => "continue",
    }).activeCancelled > 0
  );
}
