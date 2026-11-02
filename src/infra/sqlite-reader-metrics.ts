import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const MAX_SQLITE_READER_OPERATIONS = 256;

export type SqliteReaderMetric = { operation: string; count: number; readBytes: number };
export type SqliteReaderCounter = {
  operation: string;
  /** Completed measured operations, then physical storage bytes. */
  values: BigUint64Array<SharedArrayBuffer>;
};

const metrics = resolveGlobalSingleton(Symbol.for("openclaw.sqliteReaderMetrics"), () => ({
  counters: new Map<string, SqliteReaderCounter>(),
  listeners: new Set<(counter: SqliteReaderCounter) => void>(),
  workers: new Map<object, Map<string, SqliteReaderCounter>>(),
  operations: new Set<string>(),
  retired: new Map<string, SqliteReaderMetric>(),
}));

function boundedOperation<T>(entries: Map<string, T>, operation: string): string {
  return entries.has(operation) || entries.size < MAX_SQLITE_READER_OPERATIONS
    ? operation
    : "other";
}

/** Operation names come from internal reader commands, never database or session identities. */
export function sqliteReaderCounter(operation: string): SqliteReaderCounter {
  const label = boundedOperation(metrics.counters, operation);
  let counter = metrics.counters.get(label);
  if (!counter) {
    counter = { operation: label, values: new BigUint64Array(new SharedArrayBuffer(16)) };
    metrics.counters.set(label, counter);
    for (const listener of metrics.listeners) {
      listener(counter);
    }
  }
  return counter;
}

/** Register buffers once; reads update shared counters without per-operation messages. */
export function observeSqliteReaderCounters(listener: (counter: SqliteReaderCounter) => void) {
  metrics.listeners.add(listener);
  for (const counter of metrics.counters.values()) {
    listener(counter);
  }
  return () => metrics.listeners.delete(listener);
}

function accumulateSqliteReaderCounters(
  totals: Map<string, SqliteReaderMetric>,
  counters: Iterable<SqliteReaderCounter>,
): void {
  for (const counter of counters) {
    const operation = counter.operation;
    let total = totals.get(operation);
    if (!total) {
      total = { operation, count: 0, readBytes: 0 };
      totals.set(operation, total);
    }
    total.count += Number(Atomics.load(counter.values, 0));
    total.readBytes += Number(Atomics.load(counter.values, 1));
  }
}

export function receive(source: object, counter: SqliteReaderCounter): void {
  const { operation, values } = counter;
  const label =
    metrics.operations.has(operation) || metrics.operations.size < MAX_SQLITE_READER_OPERATIONS
      ? operation
      : "other";
  metrics.operations.add(label);
  let counters = metrics.workers.get(source);
  if (!counters) {
    counters = new Map();
    metrics.workers.set(source, counters);
  }
  counters.set(operation, { operation: label, values });
}

/** Native retirement folds final values before discarding the worker's shared buffers. */
export function retire(source: { memoryPort?: MessagePort }): void {
  const port = source.memoryPort;
  if (port) {
    // Short-lived workers can exit before their first registration's callback runs.
    for (let next = receiveMessageOnPort(port); next; next = receiveMessageOnPort(port)) {
      port.emit("message", next.message);
    }
  }
  const counters = metrics.workers.get(source);
  if (counters) {
    accumulateSqliteReaderCounters(metrics.retired, counters.values());
    metrics.workers.delete(source);
  }
}

export function snapshotSqliteReaderMetrics(): SqliteReaderMetric[] {
  const totals = new Map(
    [...metrics.retired].map(([operation, metric]) => [operation, { ...metric }]),
  );
  for (const counters of metrics.workers.values()) {
    accumulateSqliteReaderCounters(totals, counters.values());
  }
  return [...totals.values()];
}
