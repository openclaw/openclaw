import { AsyncLocalStorage } from "node:async_hooks";
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
  ): Promise<T> {
    let acquiring = false;
    let nextAcquisition: (() => void) | undefined;

    function enqueueAcquisition(index: number): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // Keep idle admission synchronous without nesting the acquisition stack.
        // Each continuation must retain the locks held by its caller.
        nextAcquisition = AsyncLocalStorage.bind(() => {
          void acquire(index).then(resolve, reject);
        });
        if (acquiring) {
          return;
        }
        acquiring = true;
        try {
          while (nextAcquisition) {
            const next = nextAcquisition;
            nextAcquisition = undefined;
            next();
          }
        } finally {
          acquiring = false;
        }
      });
    }

    async function acquire(index: number): Promise<T> {
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
            return await enqueueAcquisition(index + 1);
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
    }

    return await enqueueAcquisition(0);
  };
}
