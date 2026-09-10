import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import {
  beginLifecycleDiagnosticQueue,
  type LifecycleDiagnosticOperation,
} from "./session-lifecycle-diagnostics.js";

export function createSessionIdentityLockRunner(state: {
  lifecycleQueues: Map<string, StoreWriterQueue>;
  mutationQueues: Map<string, StoreWriterQueue>;
}) {
  return async function runWithSessionIdentityLocks<T>(
    identities: readonly string[],
    run: () => Promise<T>,
    diagnostic?: LifecycleDiagnosticOperation,
    entryPhase?: "activation" | "run",
    kind: "lifecycle" | "mutation" = "lifecycle",
    index = 0,
  ): Promise<T> {
    const identity = identities[index];
    if (!identity) {
      if (entryPhase) {
        diagnostic?.mark(entryPhase);
      }
      return await run();
    }
    const queues = kind === "mutation" ? state.mutationQueues : state.lifecycleQueues;
    const observation =
      diagnostic && beginLifecycleDiagnosticQueue(diagnostic, kind, queues, identity);
    const pending = runQueuedStoreWrite({
      queues,
      storePath: identity,
      label:
        kind === "mutation"
          ? "runExclusiveSessionLifecycleMutation"
          : "runExclusiveSessionLifecycle",
      reentrant: true,
      timing: observation?.timing,
      fn: async () => {
        const releaseObservation = observation?.enter();
        try {
          return await runWithSessionIdentityLocks(
            identities,
            run,
            diagnostic,
            entryPhase,
            kind,
            index + 1,
          );
        } finally {
          if (index === 0 && kind === diagnostic?.rootQueue) {
            diagnostic.mark("release");
          }
          // Callback lifetime remains authoritative even if an outer caller cancels.
          releaseObservation?.();
        }
      },
    });
    observation?.watch();
    try {
      return await pending;
    } finally {
      observation?.finish();
      if (index === 0 && kind === diagnostic?.rootQueue) {
        diagnostic.finish(observation?.timing.finishedAt);
      }
    }
  };
}
