import process from "node:process";

type SignalExitBarrier = () => Promise<void>;

// Gates let bounded mutations finish before signal cleanup begins; barriers
// then prevent one cleanup from exiting while another still owns state.
const activeBarriers = new Set<SignalExitBarrier>();
const activeGates = new Set<Promise<void>>();
let activeDrain: Promise<void> | undefined;
let activeSignalExit: Promise<void> | undefined;
const activeSignalExitErrorHandlers = new Set<(error: unknown) => void>();

export function registerSignalExitGate(gate: Promise<void>): () => void {
  activeGates.add(gate);
  return () => activeGates.delete(gate);
}

export function registerSignalExitBarrier(barrier: SignalExitBarrier): () => void {
  activeBarriers.add(barrier);
  return () => activeBarriers.delete(barrier);
}

async function drainSignalExitBarriers(): Promise<void> {
  const gateResults = await Promise.allSettled(activeGates);
  const barrierResults = await Promise.allSettled([...activeBarriers].map((barrier) => barrier()));
  const failures = [...gateResults, ...barrierResults]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Signal exit cleanup failed");
  }
}

export function waitForSignalExitBarriers(): Promise<void> {
  activeDrain ??= drainSignalExitBarriers().finally(() => {
    activeDrain = undefined;
  });
  return activeDrain;
}

export function requestSignalExit(params: {
  exitCode: number;
  onError?: (error: unknown) => void;
  exit?: (code: number) => void;
}): void {
  if (params.onError) {
    activeSignalExitErrorHandlers.add(params.onError);
  }
  if (activeSignalExit) {
    return;
  }
  activeSignalExit = waitForSignalExitBarriers()
    .catch((error: unknown) => {
      for (const onError of activeSignalExitErrorHandlers) {
        try {
          onError(error);
        } catch {
          // Cleanup failure reporting must not suppress the requested exit.
        }
      }
    })
    .then(() => {
      activeSignalExit = undefined;
      activeSignalExitErrorHandlers.clear();
      if (params.exit) {
        params.exit(params.exitCode);
      } else {
        process.exit(params.exitCode);
      }
    });
}
