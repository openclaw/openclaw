import { resolveGlobalSet } from "../shared/global-singleton.js";

type SignalExitBarrier = () => Promise<void>;
type CliExitSignal = "SIGINT" | "SIGTERM";

// Gates let bounded mutations finish before signal cleanup begins; barriers
// then prevent one cleanup from exiting while another still owns state.
const activeBarriers = resolveGlobalSet<SignalExitBarrier>(
  Symbol.for("openclaw.signalExitBarriers"),
  "close-and-restart",
);
const activeGates = resolveGlobalSet<{
  finished: Promise<void>;
  interrupt?: (signal?: CliExitSignal) => void;
}>(Symbol.for("openclaw.signalExitGates"), "close-and-restart");
const activeFinalizers = resolveGlobalSet<SignalExitBarrier>(
  Symbol.for("openclaw.signalExitFinalizers"),
  "close-and-restart",
);

export function registerSignalExitGate(
  finished: Promise<void>,
  interrupt?: (signal?: CliExitSignal) => void,
): () => void {
  const gate = { finished, interrupt };
  activeGates.add(gate);
  return () => activeGates.delete(gate);
}

export function registerSignalExitBarrier(barrier: SignalExitBarrier): () => void {
  activeBarriers.add(barrier);
  return () => activeBarriers.delete(barrier);
}

/** Temporary artifacts remain available until other shutdown owners have drained. */
export function registerSignalExitFinalizer(finalizer: SignalExitBarrier): () => void {
  activeFinalizers.add(finalizer);
  return () => activeFinalizers.delete(finalizer);
}

let pendingSignalExitDrain: Promise<void> | undefined;
let pendingProcessExit: Promise<void> | undefined;

/** Broken output must not bypass a maintenance owner's asynchronous recovery. */
export function exitAfterSignalExitBarriers(code: number | string): void {
  if (pendingProcessExit) {
    return;
  }
  if (activeGates.size === 0 && activeBarriers.size === 0 && activeFinalizers.size === 0) {
    process.exit(code);
    return;
  }
  pendingProcessExit = waitForSignalExitBarriers()
    .then(() => code)
    // The output stream may itself be broken; cleanup owners report their own failures.
    .catch(() => (code === 0 || code === "0" ? 1 : code))
    .then((exitCode) => {
      pendingProcessExit = undefined;
      const outcome = process.exitCode;
      process.exit(
        (exitCode === 0 || exitCode === "0") && outcome !== undefined ? outcome : exitCode,
      );
    });
}

export function waitForSignalExitBarriers(signal?: CliExitSignal): Promise<void> {
  pendingSignalExitDrain ??= drainSignalExitBarriers(signal).finally(() => {
    pendingSignalExitDrain = undefined;
  });
  return pendingSignalExitDrain;
}

async function drainSignalExitBarriers(signal?: CliExitSignal): Promise<void> {
  const gates = [...activeGates];
  for (const gate of gates) {
    gate.interrupt?.(signal);
  }
  const gateResults = await Promise.allSettled(gates.map((gate) => gate.finished));
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
let cliDoctorSignalOwner = false;

function handleCliSignal(signal: CliExitSignal): void {
  if (cliSignalExit) {
    return;
  }
  const listener = signal === "SIGINT" ? onCliSigint : onCliSigterm;
  if (
    !cliDoctorSignalOwner &&
    process.listeners(signal).some((existing) => existing !== listener)
  ) {
    // Run first and relinquish the fallback synchronously: signal-exit observers
    // must see their original listener count, and custom owners retain their drain.
    detachCliSignalExitHandlers();
    return;
  }
  cliSignalExit = waitForSignalExitBarriers(signal)
    .catch(() => {
      process.stderr.write(
        "CLI signal cleanup did not complete. Retry the command to reclaim interrupted snapshots.\n",
      );
    })
    .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}

const onCliSigint = () => handleCliSignal("SIGINT");
const onCliSigterm = () => handleCliSignal("SIGTERM");
// Any EPIPE write raises SIGPIPE, including a child's closed stdin, so the
// signal only keeps Node's ignore disposition; EPIPE on our output decides exit.
const onCliSigpipe = () => {};
const onCliOutputError = (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE" && cliSignalOwners > 0) {
    exitAfterSignalExitBarriers(141);
  }
};

/** Doctor keeps termination custody when progress spinners observe signals.
 * Retain SIGPIPE until exit: removing its last listener restores SIG_DFL, not SIG_IGN. */
export function installCliDoctorSignalExitHandlers(): void {
  if (cliSignalOwners === 0) {
    return;
  }
  cliDoctorSignalOwner = true;
  if (!process.listeners("SIGPIPE").includes(onCliSigpipe)) {
    process.on("SIGPIPE", onCliSigpipe);
    // Run before console capture's generic EPIPE exit so closed output reports 141.
    process.stdout.prependListener("error", onCliOutputError);
    process.stderr.prependListener("error", onCliOutputError);
  }
}

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
      cliDoctorSignalOwner = false;
      detachCliSignalExitHandlers();
    }
  };
}

/** Command error/output finalization cannot race an accepted signal's cleanup. */
export async function waitForCliSignalExit(): Promise<void> {
  await Promise.all([cliSignalExit, pendingProcessExit]);
}
