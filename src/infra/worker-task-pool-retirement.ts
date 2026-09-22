import type { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";
import {
  cancelWorkerNativeSections,
  waitForWorkerNativeSections,
} from "./worker-task-native-sections.js";
import type { Slot, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

export type WorkerTaskPoolRetirement<Input, Output> = {
  retire(slot: Slot<Input, Output>): Promise<void>;
  retireIdle(resourceClosures: WeakMap<Worker, { pending: number }>): void;
  retryFailedRetirements(): Promise<void>;
  joinArtifacts(): Promise<void[]>;
};

export function createWorkerTaskPoolRetirement<Input, Output>({
  slots,
  options,
  clearIdleTimer,
  runInContext,
  dispatch,
}: {
  slots: Set<Slot<Input, Output>>;
  options: WorkerTaskPoolOptions<Output>;
  clearIdleTimer: (timer: Slot<Input, Output>["idleTimer"]) => void;
  runInContext: <T>(operation: () => T) => T;
  dispatch: () => void;
}): WorkerTaskPoolRetirement<Input, Output> {
  const artifactCleanups = new Set<Promise<void>>();

  function retire(slot: Slot<Input, Output>): Promise<void> {
    clearIdleTimer(slot.idleTimer);
    cancelWorkerNativeSections(slot.nativeSections);
    // Retain error listeners until exit: termination can race a worker startup error.
    // Constructor observers can retire this slot before its Worker is assigned.
    return (slot.retiring ??= Promise.resolve()
      .then(async () => {
        if (slot.worker) {
          // Node can abort if termination interrupts zlib between allocation and initialization.
          // Keep custody until the current bounded native operation settles, including on timeout.
          const settlement = waitForWorkerNativeSections(slot.nativeSections);
          if (settlement) {
            await settlement;
          }
          await slot.worker.terminate();
        }
        slot.retired = true;
      })
      .catch((error: unknown) => {
        try {
          void Promise.resolve(options.onRetirementFailure?.(error)).catch(() => undefined);
        } catch {
          // Observer failures cannot replace the termination failure or its retained custody.
        }
        throw error;
      })
      .then(() => {
        const releaseResources = slot.releaseResources;
        if (releaseResources) {
          runInContext(() => {
            const cleanup = runBestEffortCleanup({
              cleanup: releaseResources,
              onError: (error) =>
                process.emitWarning(`Worker task resource release failed: ${String(error)}`),
            });
            // Release execution capacity at exit; terminal close still joins disposable files.
            artifactCleanups.add(cleanup);
            void cleanup.then(() => artifactCleanups.delete(cleanup));
          });
        }
        slot.worker?.removeAllListeners();
        slots.delete(slot);
        for (const complete of slot.completions ?? []) {
          complete();
        }
        slot.completions = undefined;
        dispatch();
      })
      .catch((error: unknown) => {
        // Keep native custody and queued input charges until a later close/rotation joins exit.
        slot.retirementFailed = true;
        slot.retiring = undefined;
        throw error;
      }));
  }

  /** Join failed native retirements without interrupting healthy tasks. */
  async function retryFailedRetirements(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...slots].filter((slot) => slot.retirementFailed).map((slot) => retire(slot)),
    );
    outcomes.push(...(await Promise.allSettled(artifactCleanups)));
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected"
        ? [toErrorObject(outcome.reason, "worker retirement retry failed")]
        : [],
    );
    const firstError = errors[0];
    if (firstError) {
      throw errors.length === 1
        ? firstError
        : new AggregateError(errors, "Worker retirement retries failed", { cause: firstError });
    }
  }

  return {
    retire,
    retireIdle(resourceClosures) {
      for (const slot of slots) {
        if (
          !slot.task &&
          !slot.retiring &&
          !slot.retirementFailed &&
          slot.worker &&
          !resourceClosures.get(slot.worker)?.pending
        ) {
          void retire(slot).catch(() => undefined);
        }
      }
    },
    retryFailedRetirements,
    joinArtifacts: () => Promise.all(artifactCleanups),
  };
}
