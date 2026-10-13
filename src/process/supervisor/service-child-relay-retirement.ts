import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { toErrorObject } from "../../infra/errors.js";
import type { ProcessCleanupResult } from "./types.js";

/** Transport loss asks a native owner to drain; killing it would abandon descendant custody. */
export function stopServiceChildOwner(child: ChildProcess, retainDescendantCustody: boolean): void {
  if (retainDescendantCustody) {
    if (child.connected) {
      child.disconnect();
    }
  } else {
    child.kill("SIGKILL");
  }
}

/** The relay reaps its anchor before the host releases the retained relay handle. */
export function createServiceChildRelayRetirement(params: {
  child: ChildProcess;
  generation: string;
  canRetire: () => boolean;
  anchorGone: () => boolean;
  startedAt: () => number;
  nextSequence: () => number;
}) {
  let requested = false;
  let sequence: number | undefined;
  let signaledAt: number | undefined;
  let signalError: Error | undefined;
  let relaySignaled = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
  const recordError = (error: unknown) => {
    const failure = toErrorObject(error, "service child retirement signal failed");
    signalError = signalError
      ? new AggregateError([signalError, failure], "service child retirement signals failed")
      : failure;
  };
  const reconcile = () => {
    if (!requested || exit || !params.canRetire()) {
      return;
    }
    signaledAt ??= performance.now();
    if (params.anchorGone()) {
      if (relaySignaled) {
        return;
      }
      relaySignaled = true;
      try {
        if (!params.child.kill("SIGKILL")) {
          recordError(new Error("retained relay SIGKILL was not delivered"));
        }
      } catch (error) {
        recordError(error);
      }
    } else if (sequence === undefined) {
      sequence = params.nextSequence();
      try {
        params.child.send(
          { type: "cancel", generation: params.generation, sequence, signal: "SIGKILL" },
          (error) => {
            if (error) {
              recordError(error);
            }
          },
        );
      } catch (error) {
        recordError(error);
      }
    }
  };
  const diagnostics = () => ({
    durationMs: (exit?.at ?? performance.now()) - params.startedAt(),
    escalationAfterMs: signaledAt === undefined ? undefined : signaledAt - params.startedAt(),
    signalError,
  });
  return {
    request: () => {
      requested = true;
      reconcile();
    },
    reconcile,
    recordSignalError(error: Error): boolean {
      if (signaledAt === undefined) {
        return false;
      }
      recordError(error);
      return true;
    },
    observeExit: (code: number | null, signal: NodeJS.Signals | null) => {
      exit = { code, signal, at: performance.now() };
    },
    diagnostics,
    get result(): ProcessCleanupResult | undefined {
      return exit && signaledAt !== undefined
        ? {
            reason: "forced-relay-exit",
            signalRequested: "SIGKILL",
            ...diagnostics(),
            escalationAfterMs: signaledAt - params.startedAt(),
            exit: { code: exit.code, signal: exit.signal },
          }
        : undefined;
    },
  };
}
