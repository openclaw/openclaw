import { getChildLogger } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type SnapshotFlight = {
  base?: PreparedSqliteReadOnlyLocation;
  cleanupFailure?: { error: unknown };
  controller: AbortController;
  leases: number;
  promise: Promise<PreparedSqliteReadOnlyLocation>;
  settled: Promise<PreparedSqliteReadOnlyLocation>;
  finishWaiters: () => void;
  waiters: number;
};

const snapshotFlights = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSnapshotFlights"),
  () => new Map<string, SnapshotFlight>(),
);

async function waitForFlight<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  withdraw: () => void,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) {
    return promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const release = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      release();
      withdraw();
      reject(signal.reason instanceof Error ? signal.reason : new Error("SQLite snapshot aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
}

function cleanupUnleasedFlight(key: string, flight: SnapshotFlight): void {
  if (flight.waiters > 0 || flight.leases > 0) {
    return;
  }
  if (snapshotFlights.get(key) === flight) {
    snapshotFlights.delete(key);
  }
  if (!flight.base) {
    flight.controller.abort();
  }
}

function releaseFlight(key: string, flight: SnapshotFlight, asyncCleanup: false): boolean;
function releaseFlight(key: string, flight: SnapshotFlight, asyncCleanup: true): Promise<boolean>;
function releaseFlight(
  key: string,
  flight: SnapshotFlight,
  asyncCleanup: boolean,
): boolean | Promise<boolean> {
  if (flight.leases > 1 || flight.waiters > 0) {
    flight.leases -= 1;
    return asyncCleanup ? Promise.resolve(true) : true;
  }
  const finish = (cleaned: boolean) => {
    if (cleaned) {
      flight.leases -= 1;
      if (snapshotFlights.get(key) === flight) {
        snapshotFlights.delete(key);
      }
    }
    return cleaned;
  };
  return asyncCleanup ? flight.base!.cleanupAsync().then(finish) : finish(flight.base!.cleanup());
}

function leaseFlight(
  key: string,
  flight: SnapshotFlight,
  base: PreparedSqliteReadOnlyLocation,
): PreparedSqliteReadOnlyLocation {
  flight.leases += 1;
  let active = true;
  let pending: Promise<boolean> | undefined;
  return {
    location: base.location,
    cleanupRoot: base.cleanupRoot,
    cleanup: () => {
      if (!active) {
        return true;
      }
      if (pending) {
        return false;
      }
      const cleaned = releaseFlight(key, flight, false);
      active = !cleaned;
      return cleaned;
    },
    cleanupAsync: () => {
      if (!active) {
        return pending ?? Promise.resolve(true);
      }
      pending ??= releaseFlight(key, flight, true)
        .then((cleaned) => {
          active = !cleaned;
          return cleaned;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

export async function prepareSingleFlightSqliteSnapshot(
  databasePath: string,
  operation: string,
  producer: (
    signal: AbortSignal,
    recordCleanupFailure: (error: unknown) => void,
  ) => Promise<PreparedSqliteReadOnlyLocation>,
  signal?: AbortSignal,
  lifecycle?: {
    trackProducer?: (producer: Promise<PreparedSqliteReadOnlyLocation>) => void;
  },
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  const identity = readDatabasePathIdentitySync(databasePath);
  const key = `${identity.key}:${operation}`;
  let flight = snapshotFlights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const waitersDrained = createDeferredCore();
    const produced = Promise.resolve().then(() =>
      producer(controller.signal, (error) => {
        flight!.cleanupFailure ??= { error };
      }),
    );
    flight = {
      controller,
      leases: 0,
      waiters: 0,
      promise: produced,
      settled: produced,
      finishWaiters: () => waitersDrained.resolve(),
    };
    snapshotFlights.set(key, flight);
    flight.promise = produced.then(
      (base) => {
        flight!.base = base;
        if (snapshotFlights.get(key) === flight) {
          snapshotFlights.delete(key);
        }
        return base;
      },
      (error: unknown) => {
        if (snapshotFlights.get(key) === flight) {
          snapshotFlights.delete(key);
        }
        throw error;
      },
    );
    // A cancelled caller detaches promptly, but its lifecycle owner must still
    // join production, waiter admission and any cleanup of unpublished bytes.
    flight.settled = retainSnapshotWork(
      flight.promise.then(async (base) => {
        await waitersDrained.promise;
        if (flight!.leases === 0) {
          try {
            if (!(await base.cleanupAsync())) {
              throw new Error("SQLite orphan snapshot cleanup did not complete");
            }
          } catch (error) {
            flight!.cleanupFailure ??= { error };
            // Prepared locations retain failed removals in the existing temp
            // directory registry for signal/exit retry; never drop that owner.
            try {
              getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
                { cleanupRoot: base.cleanupRoot },
                "SQLite orphan snapshot cleanup failed; retained for cleanup retry.",
              );
            } catch {
              // Diagnostics must not replace the cleanup failure.
            }
            throw error;
          }
        }
        return base;
      }),
      () => controller.abort(new Error("SQLite snapshot owner stopped")),
    );
    // An orphan has no caller left to observe rejection. The lifecycle retains
    // the original rejecting settlement promise, not this observation branch.
    void flight.settled.catch(() => undefined);
  }
  lifecycle?.trackProducer?.(flight.settled);
  flight.waiters += 1;
  let waiting = true;
  const withdraw = () => {
    if (!waiting) {
      return;
    }
    waiting = false;
    flight.waiters -= 1;
    if (flight.waiters === 0) {
      flight.finishWaiters();
    }
    // Abort queued production before its microtask can allocate native resources.
    cleanupUnleasedFlight(key, flight);
  };
  let outcome: { value: PreparedSqliteReadOnlyLocation } | { error: unknown };
  try {
    const base = await waitForFlight(flight.promise, signal, withdraw);
    signal?.throwIfAborted();
    outcome = { value: leaseFlight(key, flight, base) };
  } catch (error) {
    outcome = { error };
  }
  withdraw();
  if (flight.waiters === 0 && flight.leases === 0 && !lifecycle?.trackProducer) {
    // A standalone last caller is the cleanup owner. Only an explicit
    // enclosing lifecycle may take custody and let that caller detach.
    try {
      await flight.settled;
    } catch {
      // Preserve caller cancellation unless cleanup recorded an independent failure.
      if (flight.cleanupFailure) {
        throw flight.cleanupFailure.error;
      }
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
