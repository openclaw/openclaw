import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { materializeErrorStack } from "../../infra/error-graph-internal.js";
import { toErrorObject } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sendServiceChildMessage } from "./service-child-protocol.js";
import type { ProcessCleanupResult } from "./types.js";

/** The outside subreaper, not its command anchor, certifies a strict Linux tree. */
export function retainServiceChildNativeCustody(params: {
  child: ChildProcess;
  generation: string;
  nextSequence: () => number;
  onLost: (message: string) => void;
}) {
  const closed = createDeferredCore();
  let confirmed = false;
  let exited = false;
  let disconnected = false;
  const finish = () => {
    if (exited && disconnected && !confirmed) {
      params.onLost("custody owner exited without kernel descendant extinction");
    }
  };
  params.child.once("exit", () => {
    exited = true;
    finish();
  });
  params.child.once("disconnect", () => {
    disconnected = true;
    finish();
  });
  return {
    confirm() {
      confirmed = true;
      closed.resolve();
    },
    get confirmed() {
      return confirmed;
    },
    wait: (cleanup: Promise<void>) => Promise.race([closed.promise, cleanup]),
    // Kill only the retained inner anchor; this owner must survive to reap it.
    force: () =>
      sendServiceChildMessage(params.child, {
        type: "cancel",
        generation: params.generation,
        sequence: params.nextSequence(),
        signal: "SIGKILL",
      }),
  };
}

/** Retain admitted transport for cancellation; transport loss asks the native owner to drain. */
export function stopServiceChildOwner(
  child: ChildProcess,
  retainDescendantCustody: boolean,
  cancelAdmitted?: () => void,
): void {
  if (cancelAdmitted) {
    cancelAdmitted();
    return;
  }
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
    materializeErrorStack(signalError);
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

/** Join startup cleanup without letting its failure replace the anchor's startup failure. */
export async function joinStartupFailureCleanup(
  startupError: unknown,
  acknowledgement: Promise<void> | undefined,
  cleanup: Promise<void>,
): Promise<unknown> {
  // A failed acknowledgement already loses identity, so the cleanup result reports it.
  await acknowledgement?.catch(() => {});
  const cleanupError = await cleanup.then(
    () => undefined,
    (error: unknown) => error,
  );
  return cleanupError === undefined || cleanupError === startupError
    ? startupError
    : new AggregateError(
        [startupError, cleanupError],
        toErrorObject(startupError, "service child startup failed").message,
      );
}
