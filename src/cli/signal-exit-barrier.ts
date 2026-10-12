import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";

type SignalExitBarrier = () => Promise<void>;
type CliExitSignal = "SIGINT" | "SIGTERM";

type SignalExitOwner = (code: number | string) => void;
// Process custody outlives the Gateway generations that reset ordinary barriers.
const processExitOwner = resolveGlobalSingleton<{ current?: SignalExitOwner }>(
  Symbol.for("openclaw.signalExitOwner"),
  () => ({}),
);

/** An exclusive process owner handles output failure through its normal shutdown. */
export function registerSignalExitOwner(owner: SignalExitOwner): () => void {
  if (processExitOwner.current) {
    throw new Error("A process signal exit owner is already registered");
  }
  processExitOwner.current = owner;
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (processExitOwner.current === owner) {
      processExitOwner.current = undefined;
    }
  };
}

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
let pendingProcessExit: Promise<number | string> | undefined;

/** Broken output must not bypass a maintenance owner's asynchronous recovery. */
export function exitAfterSignalExitBarriers(code: number | string): void {
  if (processExitOwner.current) {
    processExitOwner.current(code);
    return;
  }
  if (pendingProcessExit) {
    return;
  }
  if (activeGates.size === 0 && activeBarriers.size === 0 && activeFinalizers.size === 0) {
    process.exitCode = code;
    pendingProcessExit = Promise.resolve(code);
    return;
  }
  pendingProcessExit = waitForSignalExitBarriers()
    .then(() => code)
    // The output stream may itself be broken; cleanup owners report their own failures.
    .catch(() => (code === 0 || code === "0" ? 1 : code))
    .then((exitCode) => {
      const outcome = process.exitCode;
      const finalCode =
        (exitCode === 0 || exitCode === "0") && outcome != null ? outcome : exitCode;
      if (processExitOwner.current) {
        processExitOwner.current(finalCode);
      } else {
        process.exitCode = finalCode;
      }
      return finalCode;
    });
}

export function waitForSignalExitBarriers(signal?: CliExitSignal): Promise<void> {
  pendingSignalExitDrain ??= drainSignalExitBarriers(signal).finally(() => {
    pendingSignalExitDrain = undefined;
  });
  if (signal && !cliSignalExit) {
    const code = signal === "SIGINT" ? 130 : 143;
    // Specialized update owners share this accepted outcome with the outer
    // finalizer, even when cancellation unwinds through a later command error.
    cliSignalExit = pendingSignalExitDrain.then(
      () => code,
      () => code,
    );
  }
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

let cliSignalExit: Promise<number> | undefined;
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
    .then(() => {
      const code = signal === "SIGINT" ? 130 : 143;
      process.exitCode = code;
      return code;
    });
}

const onCliSigint = () => handleCliSignal("SIGINT");
const onCliSigterm = () => handleCliSignal("SIGTERM");
const onCliSigpipe = () => {
  if (cliSignalOwners > 0) {
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
export async function waitForCliSignalExit(): Promise<number | string | undefined> {
  const signalExit = cliSignalExit;
  const requestedExit = pendingProcessExit;
  const [signalCode, requestedCode] = await Promise.all([signalExit, requestedExit]);
  // The outer finalizer consumes the recorded terminal decision, so a queued
  // successful command cannot overwrite an accepted signal or output failure.
  if (cliSignalExit === signalExit) {
    cliSignalExit = undefined;
  }
  if (pendingProcessExit === requestedExit) {
    pendingProcessExit = undefined;
  }
  // A queued success cannot erase an accepted signal. Explicit failure
  // requests still keep their status when both shutdown paths share a drain.
  if ((requestedCode === 0 || requestedCode === "0") && signalCode !== undefined) {
    return signalCode;
  }
  return requestedCode ?? signalCode;
}
