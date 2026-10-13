import {
  createRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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

type PreparedSnapshot = PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation;
type SnapshotProducer = (
  signal: AbortSignal,
  recordFailure: (error: unknown) => void,
) => {
  operation: RetainedOperation<PreparedSnapshot>;
  startClose?: () => RetainedOperation<void>;
};
type SnapshotFlight = {
  controller: AbortController;
  references: number;
  listeners: Set<() => void>;
  production: RetainedOperation<PreparedSnapshot>;
  settled: RetainedOperation<PreparedSnapshot>;
  closeProducer(): RetainedOperation<void>;
};
type SnapshotLifecycle = {
  trackProducer?: (producer: Promise<PreparedSqliteReadOnlyLocation>) => void;
  /** Shared bytes must belong to the same source lifetime. */
  scope?: object;
};

const snapshotFlights = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSnapshotFlights"),
  () => ({
    unscoped: new Map<string, SnapshotFlight>(),
    scoped: new WeakMap<object, Map<string, SnapshotFlight>>(),
  }),
);

function completed<T>(value: T): RetainedOperation<T> {
  const retained = createRetainedOperation<T>(() => {});
  retained.resolve(value);
  return retained.operation;
}

function serviceWhenSettled(source: RetainedOperation<unknown>, service: () => void): void {
  void source.result.then(service, service);
}

function createFlight(
  flights: Map<string, SnapshotFlight>,
  key: string,
  producer: SnapshotProducer,
): SnapshotFlight {
  let source: ReturnType<SnapshotProducer> | undefined;
  let started = false;
  let servicing = false;
  let cleanup: RetainedOperation<boolean> | undefined;
  let closing: RetainedOperation<void> | undefined;
  let cleanupFailure: unknown;
  const production = createRetainedOperation<PreparedSnapshot>(() => {
    if (servicing || production.operation.read().status !== "pending") {
      return;
    }
    servicing = true;
    try {
      if (!started) {
        started = true;
        source = producer(flight.controller.signal, (error) => (cleanupFailure = error));
        serviceWhenSettled(source.operation, serviceFlight);
      }
      source!.operation.service();
      const outcome = source!.operation.read();
      if (outcome.status === "fulfilled") {
        production.resolve(outcome.value);
      } else if (outcome.status === "rejected") {
        production.reject(outcome.error);
      }
    } catch (error) {
      production.reject(error);
    } finally {
      servicing = false;
    }
  });
  const settled = createRetainedOperation<PreparedSnapshot>(() => {
    production.operation.service();
    const outcome = production.operation.read();
    if (outcome.status === "pending" || settled.operation.read().status !== "pending") {
      return;
    }
    if (flights.get(key) === flight) {
      flights.delete(key);
    }
    if (outcome.status === "rejected") {
      settled.reject(cleanupFailure ?? outcome.error);
    } else if (flight.references > 0) {
      settled.resolve(outcome.value);
    } else {
      if (!cleanup) {
        cleanup = releaseSnapshot(flight, outcome.value);
        serviceWhenSettled(cleanup, () => settled.operation.service());
      }
      cleanup.service();
      const removed = cleanup.read();
      if (removed.status === "fulfilled") {
        settled.resolve(outcome.value);
      } else if (removed.status === "rejected") {
        settled.reject(removed.error);
      }
    }
  });
  function serviceFlight() {
    production.operation.service();
    for (const service of flight.listeners) {
      service();
    }
    settled.operation.service();
  }
  const flight: SnapshotFlight = {
    controller: new AbortController(),
    references: 0,
    listeners: new Set(),
    production: production.operation,
    settled: settled.operation,
    closeProducer() {
      closing ??= source?.startClose?.() ?? completed(undefined);
      return closing;
    },
  };
  void retainSnapshotWork(settled.operation.result, () => {
    flight.controller.abort(new Error("SQLite snapshot owner stopped"));
    serviceFlight();
  });
  return flight;
}

function releaseSnapshot(
  flight: SnapshotFlight,
  base: PreparedSnapshot,
): RetainedOperation<boolean> {
  return flatMapRetainedOperation(base.startCleanup(), (removed) => {
    if (!removed) {
      throw new SqliteSnapshotCleanupError("SQLite snapshot lease cleanup did not complete");
    }
    return mapRetainedOperation(flight.closeProducer(), () => true);
  });
}

function leaseFlight(flight: SnapshotFlight, base: PreparedSnapshot): PreparedSnapshot {
  let released = false;
  let cleanup: RetainedOperation<boolean> | undefined;
  const releaseReference = () => {
    if (!released) {
      released = true;
      flight.references--;
    }
    return flight.references === 0;
  };
  const startCleanup = () => {
    cleanup ??= !released && releaseReference() ? releaseSnapshot(flight, base) : completed(true);
    return cleanup;
  };
  return {
    location: base.location,
    cleanupRoot: base.cleanupRoot,
    cleanup() {
      if (released) {
        return cleanup ? cleanup.read().status === "fulfilled" : true;
      }
      if (flight.references > 1) {
        releaseReference();
        return true;
      }
      const removed = base.cleanup();
      if (removed) {
        releaseReference();
      }
      return removed;
    },
    cleanupAsync: () => startCleanup().result,
    startCleanup,
  };
}

function startSnapshotFlight(
  databasePath: string,
  operation: string,
  producer: SnapshotProducer,
  signal?: AbortSignal,
  lifecycle?: SnapshotLifecycle,
): RetainedSqliteSnapshotPreparation & RetainedOperation<PreparedSnapshot> {
  signal?.throwIfAborted();
  const key = `${readDatabasePathIdentitySync(databasePath).key}:${operation}`;
  let flights = snapshotFlights.unscoped;
  if (lifecycle?.scope) {
    let scoped = snapshotFlights.scoped.get(lifecycle.scope);
    if (!scoped) {
      scoped = new Map();
      snapshotFlights.scoped.set(lifecycle.scope, scoped);
    }
    flights = scoped;
  }
  let flight = flights.get(key);
  if (!flight) {
    flight = createFlight(flights, key, producer);
    flights.set(key, flight);
  }
  const selected = flight;
  selected.references++;
  lifecycle?.trackProducer?.(selected.settled.result);
  let closed = false;
  let withdrew = false;
  let closing: RetainedOperation<void> | undefined;
  const retained = createRetainedOperation<PreparedSnapshot>(() => {
    if (retained.operation.read().status !== "pending") {
      return;
    }
    if (closed || signal?.aborted) {
      if (!withdrew) {
        withdrew = true;
        selected.references--;
      }
      if (selected.references === 0) {
        selected.controller.abort(signal?.reason);
        if (flights.get(key) === selected) {
          flights.delete(key);
        }
        if (!lifecycle?.trackProducer) {
          selected.settled.service();
          if (selected.settled.read().status === "pending") {
            return;
          }
        }
      }
      retained.reject(signal?.reason ?? new Error("SQLite snapshot preparation closed"));
    } else {
      selected.production.service();
      const outcome = selected.production.read();
      if (outcome.status === "pending") {
        return;
      }
      if (outcome.status === "fulfilled") {
        retained.resolve(leaseFlight(selected, outcome.value));
      } else {
        selected.references--;
        retained.reject(outcome.error);
      }
    }
    signal?.removeEventListener("abort", service);
    selected.listeners.delete(service);
    selected.settled.service();
  });
  const service = () => retained.operation.service();
  serviceWhenSettled(selected.settled, service);
  selected.listeners.add(service);
  signal?.addEventListener("abort", service, { once: true });
  queueMicrotask(service);
  return {
    ...retained.operation,
    startClose() {
      closed = true;
      retained.operation.service();
      const outcome = retained.operation.read();
      closing ??=
        outcome.status === "fulfilled"
          ? mapRetainedOperation(outcome.value.startCleanup(), () => undefined)
          : selected.references === 0
            ? selected.closeProducer()
            : completed(undefined);
      return closing;
    },
  };
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
        return {
          ...base,
          startCleanup: () => startAwaitedSnapshotWork(() => base.cleanupAsync()),
        };
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
    recordFailure: (error: unknown) => void,
  ) => RetainedOperation<PreparedSnapshot> & {
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
      return { operation: source, startClose: () => source.startClose() };
    },
    signal,
    lifecycle,
  );
}
