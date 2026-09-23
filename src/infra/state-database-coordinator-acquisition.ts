import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { sleepWithAbort } from "./backoff.js";
import {
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
  withStateDatabaseCoordinatorRuntimeDirectory,
  type StateDatabaseCoordinatorRuntime,
} from "./state-database-coordinator.js";

const log = createSubsystemLogger("state/coordinator");

/** Wait only for native acquisition; validation, execution and cleanup are never retried. */
export async function acquireStateDatabaseCoordinatorWithWait(params: {
  operation: "session-admission" | "mutation-worker-admission";
  databasePath: string;
  runtime: StateDatabaseCoordinatorRuntime;
  /** Absolute deadline in the native node:perf_hooks monotonic clock domain. */
  deadlineMs: number;
  signal?: AbortSignal;
  assertCurrent?(): void | Promise<void>;
  onWait?(): void;
}) {
  const startedAt = performance.now();
  let acquisitionFailed = false;
  let notified = false;
  let attempts = 0;
  let outcome = "refused";
  try {
    const lease = await acquireWithWait({
      get deadlineMs() {
        return params.deadlineMs;
      },
      now: performance.now.bind(performance),
      pollIntervalMs: 25,
      maxPollIntervalMs: 250,
      shouldRetry: (error) =>
        acquisitionFailed &&
        error instanceof StateDatabaseCoordinatorContentionError &&
        error.family === "state-lifecycle",
      sleep: async (ms) => {
        if (!notified && performance.now() - startedAt >= 1_000) {
          notified = true;
          params.onWait?.();
        }
        await sleepWithAbort(ms, params.signal);
      },
      acquire: async () => {
        acquisitionFailed = false;
        params.signal?.throwIfAborted();
        await params.assertCurrent?.();
        params.signal?.throwIfAborted();
        if (performance.now() >= params.deadlineMs) {
          throw new StateDatabaseCoordinatorContentionError("state-lifecycle");
        }
        try {
          attempts += 1;
          return withStateDatabaseCoordinatorRuntimeDirectory(params.runtime, () =>
            acquireStateDatabaseCoordinator({
              databasePath: params.databasePath,
              busyTimeoutMs: 0,
            }),
          );
        } catch (error) {
          acquisitionFailed = true;
          throw error;
        }
      },
    });
    outcome = "acquired";
    return lease;
  } finally {
    if (attempts > 1 || notified) {
      log.debug("state lifecycle acquisition settled", {
        operation: params.operation,
        attempts,
        waitMs: Math.round(performance.now() - startedAt),
        outcome: params.signal?.aborted ? "cancelled" : outcome,
      });
    }
  }
}
