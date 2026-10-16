import { registerSignalExitBarrier } from "../cli/signal-exit-barrier.js";

// Application teardown can drain active capture without loading its storage graph.
const finalizers = new Set<() => Promise<void>>();

export function registerActiveDebugProxyCapture(finalize: () => Promise<void>): () => void {
  finalizers.add(finalize);
  const unregisterSignalBarrier = registerSignalExitBarrier(finalize);
  return () => {
    finalizers.delete(finalize);
    unregisterSignalBarrier();
  };
}

export async function finalizeActiveDebugProxyCaptures(): Promise<void> {
  const results = await Promise.allSettled(
    [...finalizers].map(async (finalize) => await finalize()),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Capture finalization failed.");
  }
}
