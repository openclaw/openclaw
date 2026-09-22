import { resolveGlobalSet } from "../shared/global-singleton.js";

type SignalExitBarrier = () => Promise<void>;

// Gates let bounded mutations finish before signal cleanup begins; barriers
// then prevent one cleanup from exiting while another still owns state.
const activeBarriers = resolveGlobalSet<SignalExitBarrier>(
  Symbol.for("openclaw.signalExitBarriers"),
  "close-and-restart",
);
const activeGates = resolveGlobalSet<Promise<void>>(
  Symbol.for("openclaw.signalExitGates"),
  "close-and-restart",
);
const activeFinalizers = resolveGlobalSet<SignalExitBarrier>(
  Symbol.for("openclaw.signalExitFinalizers"),
  "close-and-restart",
);

export function registerSignalExitGate(gate: Promise<void>): () => void {
  activeGates.add(gate);
  return () => activeGates.delete(gate);
}

export function registerSignalExitBarrier(barrier: SignalExitBarrier): () => void {
  activeBarriers.add(barrier);
  return () => activeBarriers.delete(barrier);
}

/** Temporary artifacts remain available until other shutdown owners have drained. */
export function registerSignalExitFinalizer(finalizer: SignalExitBarrier): void {
  activeFinalizers.add(finalizer);
}

let pendingSignalExitDrain: Promise<void> | undefined;

export function waitForSignalExitBarriers(): Promise<void> {
  pendingSignalExitDrain ??= drainSignalExitBarriers().finally(() => {
    pendingSignalExitDrain = undefined;
  });
  return pendingSignalExitDrain;
}

async function drainSignalExitBarriers(): Promise<void> {
  const gateResults = await Promise.allSettled(activeGates);
  const barrierResults = await Promise.allSettled(
    [...activeBarriers].map((barrier) => Promise.resolve().then(barrier)),
  );
  const finalizerResults = await Promise.allSettled(
    [...activeFinalizers].map((finalizer) => Promise.resolve().then(finalizer)),
  );
  const failures = [...gateResults, ...barrierResults, ...finalizerResults]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Signal exit cleanup failed");
  }
}

let cliSignalExit: Promise<void> | undefined;
let cliSignalOwners = 0;

function handleCliSignal(signal: "SIGINT" | "SIGTERM"): void {
  if (cliSignalExit) {
    return;
  }
  const listener = signal === "SIGINT" ? onCliSigint : onCliSigterm;
  if (process.listeners(signal).some((existing) => existing !== listener)) {
    // Run first and relinquish the fallback synchronously: signal-exit observers
    // must see their original listener count, and custom owners retain their drain.
    detachCliSignalExitHandlers();
    return;
  }
  cliSignalExit = waitForSignalExitBarriers()
    .catch(() => {
      process.stderr.write(
        "CLI signal cleanup did not complete. Retry the command to reclaim interrupted snapshots.\n",
      );
    })
    .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}

const onCliSigint = () => handleCliSignal("SIGINT");
const onCliSigterm = () => handleCliSignal("SIGTERM");

function detachCliSignalExitHandlers(): void {
  process.off("SIGINT", onCliSigint);
  process.off("SIGTERM", onCliSigterm);
}

/** Executable CLI commands share one signal owner; Gateway and update handlers
 * keep their specialized lifecycle and use these same barriers. */
export function installCliSignalExitHandlers(): () => void {
  if (cliSignalOwners++ === 0) {
    process.prependListener("SIGINT", onCliSigint);
    process.prependListener("SIGTERM", onCliSigterm);
  }
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (--cliSignalOwners === 0) {
      detachCliSignalExitHandlers();
    }
  };
}

/** Command error/output finalization cannot race an accepted signal's cleanup. */
export async function waitForCliSignalExit(): Promise<void> {
  await cliSignalExit;
}
