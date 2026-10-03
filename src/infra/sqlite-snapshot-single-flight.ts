import { getChildLogger } from "../logging/logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "./retained-operation.js";
import {
  retainSnapshotWork,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "./sqlite-readonly-location.types.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type SnapshotWaiter = { service(): void };
type SnapshotProduction = {
  base: PreparedSqliteReadOnlyLocation;
  startCleanup(): RetainedOperation<boolean>;
};
type SnapshotFlight = {
  flights: Map<string, SnapshotFlight>;
  base?: PreparedSqliteReadOnlyLocation;
  startCleanup?: () => RetainedOperation<boolean>;
  cleanupFailure?: { error: unknown };
  controller: AbortController;
  leases: number;
  waiters: number;
  listeners: Set<SnapshotWaiter>;
  production?: RetainedOperation<SnapshotProduction>;
  ownedProduction: boolean;
  startProducerClose?: () => RetainedOperation<void>;
  producerClose?: RetainedOperation<void>;
  outcome?: { value: PreparedSqliteReadOnlyLocation } | { error: unknown };
  cleanup?: RetainedOperation<boolean>;
  settled: RetainedOperation<PreparedSqliteReadOnlyLocation>;
};

const snapshotFlights = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSnapshotFlights"),
  () => ({
    unscoped: new Map<string, SnapshotFlight>(),
    scoped: new WeakMap<object, Map<string, SnapshotFlight>>(),
  }),
);

type SnapshotLifecycle = {
  trackProducer?: (producer: Promise<PreparedSqliteReadOnlyLocation>) => void;
  /** Shared bytes must belong to the same source lifetime. */
  scope?: object;
};

type SnapshotProducer = (
  signal: AbortSignal,
  recordCleanupFailure: (error: unknown) => void,
) => {
  operation: RetainedOperation<SnapshotProduction>;
  startClose?: () => RetainedOperation<void>;
};

function startCloseProducer(flight: SnapshotFlight): RetainedOperation<void> {
  if (flight.producerClose && flight.producerClose.read().status !== "rejected") {
    return flight.producerClose;
  }
  if (flight.startProducerClose) {
    flight.producerClose = flight.startProducerClose();
    void flight.producerClose.result.then(
      () => flight.settled.service(),
      () => flight.settled.service(),
    );
    return flight.producerClose;
  }
  const completion = createRetainedOperation<void>(() => {});
  if (flight.ownedProduction) {
    completion.reject(
      new SqliteSnapshotCleanupError("SQLite snapshot producer cleanup custody is unavailable"),
    );
  } else {
    // The older awaited producer family has no separately retained request lease.
    completion.resolve(undefined);
  }
  return completion.operation;
}

function removeFlight(key: string, flight: SnapshotFlight): void {
  if (flight.flights.get(key) === flight) {
    flight.flights.delete(key);
  }
}

function startReleaseFlight(key: string, flight: SnapshotFlight): RetainedOperation<boolean> {
  if (flight.leases > 1 || flight.waiters > 0) {
    const retained = createRetainedOperation<boolean>(() => {});
    flight.leases--;
    retained.resolve(true);
    return retained.operation;
  }
  const cleanup = flight.startCleanup!();
  return flatMapRetainedOperation(cleanup, (removed) => {
    if (!removed) {
      return cleanup;
    }
    return mapRetainedOperation(startCloseProducer(flight), () => {
      flight.leases--;
      removeFlight(key, flight);
      return true;
    });
  });
}

function leaseFlight(
  key: string,
  flight: SnapshotFlight,
  base: PreparedSqliteReadOnlyLocation,
): PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation {
  flight.leases++;
  let active = true;
  let pending: RetainedOperation<boolean> | undefined;
  const startCleanup = (): RetainedOperation<boolean> => {
    if (pending?.read().status === "pending") {
      return pending;
    }
    let release: RetainedOperation<boolean> | undefined;
    const retained = createRetainedOperation<boolean>(() => {
      if (!release || retained.operation.read().status !== "pending") {
        return;
      }
      release.service();
      const outcome = release.read();
      if (outcome.status === "rejected") {
        retained.reject(outcome.error);
      } else if (outcome.status === "fulfilled") {
        active = !outcome.value;
        retained.resolve(outcome.value);
      }
    });
    pending = retained.operation;
    if (!active) {
      retained.resolve(true);
    } else {
      release = startReleaseFlight(key, flight);
      void release.result.then(
        () => retained.operation.service(),
        () => retained.operation.service(),
      );
      retained.operation.service();
    }
    return retained.operation;
  };
  return {
    location: base.location,
    cleanupRoot: base.cleanupRoot,
    cleanup() {
      if (!active) {
        return true;
      }
      if (pending?.read().status === "pending") {
        return false;
      }
      if (flight.leases > 1 || flight.waiters > 0) {
        flight.leases--;
        active = false;
        return true;
      }
      const cleaned = base.cleanup();
      if (cleaned) {
        flight.leases--;
        active = false;
        removeFlight(key, flight);
      }
      return cleaned;
    },
    cleanupAsync: () => startCleanup().result,
    startCleanup,
  };
}

function createFlight(
  flights: Map<string, SnapshotFlight>,
  key: string,
  producer: SnapshotProducer | undefined,
  ownedProduction: boolean,
): SnapshotFlight {
  let pendingProducer = producer;
  let servicing = false;
  const settled = createRetainedOperation<PreparedSqliteReadOnlyLocation>(() => {
    if (servicing || settled.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      if (!flight.production && !flight.outcome) {
        try {
          const startProducer = pendingProducer;
          pendingProducer = undefined;
          if (!startProducer) {
            throw new Error("SQLite snapshot producer has already been consumed");
          }
          const production = startProducer(flight.controller.signal, (error) => {
            flight.cleanupFailure ??= { error };
          });
          flight.production = production.operation;
          flight.startProducerClose = production.startClose;
          void flight.production.result.then(
            () => settled.operation.service(),
            () => settled.operation.service(),
          );
        } catch (error) {
          flight.outcome = { error };
        }
      }
      if (!flight.outcome && flight.production) {
        flight.production.service();
        const produced = flight.production.read();
        if (produced.status === "pending") {
          return;
        }
        if (produced.status === "fulfilled") {
          flight.base = produced.value.base;
          flight.startCleanup = produced.value.startCleanup.bind(produced.value);
          flight.outcome = { value: produced.value.base };
        } else {
          flight.outcome = { error: produced.error };
        }
        // A leased location retains its cleanup owner, not the producer's caller context.
        flight.production = undefined;
      }
      removeFlight(key, flight);
      for (const waiter of Array.from(flight.listeners)) {
        waiter.service();
      }
      if (flight.waiters > 0 || !flight.outcome) {
        return;
      }
      if ("error" in flight.outcome) {
        settled.reject(flight.outcome.error);
      } else if (flight.leases > 0) {
        settled.resolve(flight.outcome.value);
      } else {
        if (!flight.cleanup) {
          flight.cleanup = flight.startCleanup!();
          void flight.cleanup.result.then(
            () => settled.operation.service(),
            () => settled.operation.service(),
          );
        }
        flight.cleanup.service();
        const removed = flight.cleanup.read();
        if (removed.status === "pending") {
          return;
        }
        if (removed.status === "rejected" || !removed.value) {
          const error =
            removed.status === "rejected"
              ? removed.error
              : new Error("SQLite orphan snapshot cleanup did not complete");
          flight.cleanupFailure ??= { error };
          try {
            getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
              { cleanupRoot: flight.base?.cleanupRoot },
              "SQLite orphan snapshot cleanup failed; retained for cleanup retry.",
            );
          } catch {
            // Diagnostics must not replace retained cleanup failure.
          }
          settled.reject(error);
        } else {
          const producerClose = startCloseProducer(flight);
          producerClose.service();
          const joined = producerClose.read();
          if (joined.status === "pending") {
            return;
          }
          if (joined.status === "rejected") {
            flight.cleanupFailure ??= { error: joined.error };
            settled.reject(joined.error);
          } else {
            settled.resolve(flight.outcome.value);
          }
        }
      }
      for (const waiter of Array.from(flight.listeners)) {
        waiter.service();
      }
    } finally {
      servicing = false;
    }
  });
  const flight: SnapshotFlight = {
    flights,
    controller: new AbortController(),
    leases: 0,
    waiters: 0,
    listeners: new Set(),
    ownedProduction,
    settled: settled.operation,
  };
  void retainSnapshotWork(settled.operation.result, () => {
    flight.controller.abort(new Error("SQLite snapshot owner stopped"));
    settled.operation.service();
  });
  return flight;
}

function startSnapshotFlight(
  databasePath: string,
  operation: string,
  producer: SnapshotProducer,
  signal?: AbortSignal,
  lifecycle?: SnapshotLifecycle,
  ownedProduction = false,
): RetainedOperation<PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation> & {
  startClose(): RetainedOperation<void>;
} {
  signal?.throwIfAborted();
  const identity = readDatabasePathIdentitySync(databasePath);
  const key = `${identity.key}:${operation}`;
  let flights = snapshotFlights.unscoped;
  if (lifecycle?.scope) {
    const scoped = snapshotFlights.scoped.get(lifecycle.scope);
    if (scoped) {
      flights = scoped;
    } else {
      flights = new Map();
      snapshotFlights.scoped.set(lifecycle.scope, flights);
    }
  }
  let flight = flights.get(key);
  if (!flight) {
    flight = createFlight(flights, key, producer, ownedProduction);
    flights.set(key, flight);
  }
  const selected = flight;
  lifecycle?.trackProducer?.(selected.settled.result);
  selected.waiters++;
  let waiting = true;
  let servicing = false;
  let closeRequested = false;
  let closed = false;
  let closing: RetainedOperation<void> | undefined;
  const closeReason = new Error("SQLite snapshot preparation closed");
  let outcome:
    | { value: PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation }
    | { error: unknown }
    | undefined;
  const retained = createRetainedOperation<
    PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation
  >(() => {
    if (servicing || retained.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      if (!outcome && (closeRequested || signal?.aborted)) {
        outcome = {
          error:
            signal?.reason instanceof Error
              ? signal.reason
              : closeRequested
                ? closeReason
                : new Error("SQLite snapshot aborted"),
        };
      }
      if (!outcome) {
        selected.settled.service();
        if (!selected.outcome) {
          return;
        }
        outcome =
          "error" in selected.outcome
            ? selected.outcome
            : { value: leaseFlight(key, selected, selected.outcome.value) };
      }
      if (waiting) {
        waiting = false;
        selected.waiters--;
        signal?.removeEventListener("abort", serviceWaiter);
        if (selected.waiters === 0 && selected.leases === 0) {
          removeFlight(key, selected);
          if (!selected.base) {
            selected.controller.abort();
          }
        }
      }
      selected.settled.service();
      if (selected.waiters === 0 && selected.leases === 0 && !lifecycle?.trackProducer) {
        if (selected.settled.read().status === "pending") {
          return;
        }
        if (selected.cleanupFailure) {
          outcome = { error: selected.cleanupFailure.error };
        }
      }
      selected.listeners.delete(retained.operation);
      if ("error" in outcome) {
        retained.reject(outcome.error);
      } else {
        retained.resolve(outcome.value);
      }
    } finally {
      servicing = false;
    }
  });
  const serviceWaiter = retained.operation.service.bind(retained.operation);
  selected.listeners.add(retained.operation);
  signal?.addEventListener("abort", serviceWaiter, { once: true });
  // Awaited callers and named synchronous servicing consume this same producer.
  queueMicrotask(() => retained.operation.service());
  if (signal?.aborted) {
    retained.operation.service();
  }
  const startClose = (): RetainedOperation<void> => {
    if (closing?.read().status === "pending") {
      return closing;
    }
    closeRequested = true;
    let leaseClose: RetainedOperation<boolean> | undefined;
    let producerClose: RetainedOperation<void> | undefined;
    let servicingClose = false;
    const completion = createRetainedOperation<void>(() => {
      if (servicingClose || completion.operation.read().status !== "pending") {
        return;
      }
      servicingClose = true;
      try {
        if (closed) {
          completion.resolve(undefined);
          return;
        }
        retained.operation.service();
        selected.settled.service();
        const alone = selected.waiters === 0 && selected.leases === 0;
        if (!selected.outcome && alone && selected.startProducerClose) {
          // The final cancelled participant must close accepted work even before a result exists.
          if (!producerClose) {
            producerClose = startCloseProducer(selected);
            void producerClose.result.then(
              () => completion.operation.service(),
              () => completion.operation.service(),
            );
          }
          producerClose.service();
          const earlyClose = producerClose.read();
          if (earlyClose.status === "rejected") {
            throw earlyClose.error;
          }
        }
        if (!selected.outcome) {
          return;
        }
        if (outcome && "value" in outcome) {
          if (!leaseClose) {
            leaseClose = outcome.value.startCleanup();
            void leaseClose.result.then(
              () => completion.operation.service(),
              () => completion.operation.service(),
            );
          }
          leaseClose.service();
          const released = leaseClose.read();
          if (released.status === "pending") {
            return;
          }
          if (released.status === "rejected") {
            throw released.error;
          }
          if (!released.value) {
            throw new SqliteSnapshotCleanupError("SQLite snapshot lease cleanup did not complete");
          }
        } else if (
          !("value" in selected.outcome && (selected.leases > 0 || selected.waiters > 0))
        ) {
          // A failed result is never evidence that the original producer joined.
          if (!producerClose) {
            producerClose = startCloseProducer(selected);
            void producerClose.result.then(
              () => completion.operation.service(),
              () => completion.operation.service(),
            );
          }
          producerClose.service();
          const joined = producerClose.read();
          if (joined.status === "pending") {
            return;
          }
          if (joined.status === "rejected") {
            throw joined.error;
          }
        }
        closed = true;
        completion.resolve(undefined);
      } catch (error) {
        completion.reject(error);
      } finally {
        servicingClose = false;
      }
    });
    closing = completion.operation;
    void retained.operation.result.then(
      () => completion.operation.service(),
      () => completion.operation.service(),
    );
    void selected.settled.result.then(
      () => completion.operation.service(),
      () => completion.operation.service(),
    );
    completion.operation.service();
    return completion.operation;
  };
  return { ...retained.operation, startClose };
}

/** Promise-only producers remain on their existing awaited path, never a sync bridge. */
function startAwaitedSnapshotWork<T>(produce: () => Promise<T>): RetainedOperation<T> {
  const retained = createRetainedOperation<T>(() => {});
  void Promise.resolve().then(produce).then(retained.resolve, retained.reject);
  return retained.operation;
}

export async function prepareSingleFlightSqliteSnapshot(
  databasePath: string,
  operation: string,
  producer: (
    signal: AbortSignal,
    recordCleanupFailure: (error: unknown) => void,
  ) => Promise<PreparedSqliteReadOnlyLocation>,
  signal?: AbortSignal,
  lifecycle?: SnapshotLifecycle,
): Promise<PreparedSqliteReadOnlyLocation> {
  return startSnapshotFlight(
    databasePath,
    operation,
    (flightSignal, recordFailure) => ({
      operation: startAwaitedSnapshotWork(async () => {
        const base = await producer(flightSignal, recordFailure);
        return { base, startCleanup: () => startAwaitedSnapshotWork(() => base.cleanupAsync()) };
      }),
    }),
    signal,
    lifecycle,
  ).result;
}

export function startSingleFlightSqliteSnapshot(
  databasePath: string,
  operation: string,
  producer: (
    signal: AbortSignal,
    recordCleanupFailure: (error: unknown) => void,
  ) => RetainedOperation<
    PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation
  > & {
    startClose(): RetainedOperation<void>;
  },
  signal?: AbortSignal,
  lifecycle?: SnapshotLifecycle,
): RetainedSqliteSnapshotPreparation {
  return startSnapshotFlight(
    databasePath,
    operation,
    (flightSignal, recordFailure) => {
      const source = producer(flightSignal, recordFailure);
      const retained = createRetainedOperation<SnapshotProduction>(() => {
        source.service();
        const outcome = source.read();
        if (outcome.status === "fulfilled") {
          retained.resolve({
            base: outcome.value,
            startCleanup: () => outcome.value.startCleanup(),
          });
        } else if (outcome.status === "rejected") {
          retained.reject(outcome.error);
        }
      });
      void source.result.then(
        () => retained.operation.service(),
        () => retained.operation.service(),
      );
      return { operation: retained.operation, startClose: () => source.startClose() };
    },
    signal,
    lifecycle,
    true,
  );
}
