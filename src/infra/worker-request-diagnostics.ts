import { AsyncLocalStorage } from "node:async_hooks";
import { runWithAsyncStore } from "../shared/async-store.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasInternalDiagnosticEventInterest } from "./diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "./diagnostic-events.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import { normalizeWorkerRequestClass } from "./sqlite-worker-request-class.js";
import { workerScriptName } from "./worker-diagnostic-script.js";
import type { WorkerRequestKind } from "./worker-request-kind.js";

const workerStarts = resolveGlobalSingleton(
  Symbol.for("openclaw.workerStartObservation"),
  () => new AsyncLocalStorage<(script: string) => void>(),
);

/** Startup observations inherit caller scope without changing worker lifetime ownership. */
export function runWithWorkerStartObserver<T>(observer: (script: string) => void, run: () => T): T {
  return workerStarts.run(observer, run);
}

/** Carry only the diagnostic callback across the pool's detached construction boundary. */
export function captureWorkerStartObserver(url: URL): (() => void) | undefined {
  const observer = workerStarts.getStore();
  return observer ? () => observer(workerScriptName(url)) : undefined;
}

export type WorkerRequestObservation = {
  requestClass?: string;
  threadId?: number;
  startedAt?: number;
  timing?: DiagnosticWorkerRequestFields["timing"];
  recordTransactions?(count: number): void;
  started(this: void, workerThreadId?: number): void;
  completed(this: void): void;
};

export type WorkerRequestMetricsListener = (
  kind: WorkerRequestKind,
  requestClass: string,
  phase: DiagnosticWorkerRequestFields["phase"],
  queueDepth: number,
  queueWaitMs: number | undefined,
  durationMs: number | undefined,
  timing: Readonly<DiagnosticWorkerRequestFields["timing"]>,
) => void;

const metricsListeners = resolveGlobalSingleton(
  Symbol.for("openclaw.workerRequestMetricsListeners"),
  () => new Set<WorkerRequestMetricsListener>(),
);

/** Trusted exporters consume borrowed timing fields synchronously, without event snapshots. */
export function onWorkerRequestMetrics(listener: WorkerRequestMetricsListener): () => void {
  metricsListeners.add(listener);
  return () => {
    metricsListeners.delete(listener);
  };
}

export type SqliteWorkerReservationObservation = {
  operations: Set<string>;
  transactionCount?: number;
  active?: WorkerRequestObservation;
};

const reservations = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerReservationObservation"),
  () => new AsyncLocalStorage<SqliteWorkerReservationObservation>(),
);

export function withSqliteWorkerReservationObservation<T>(
  observation: SqliteWorkerReservationObservation,
  run: () => T,
): T {
  return runWithAsyncStore(reservations, observation, run);
}

const detailedTiming = isDiagnosticFlagEnabled("sqlite.worker-timing");

const queued = resolveGlobalSingleton(
  Symbol.for("openclaw.workerRequestQueueDepth"),
  () => new Map<WorkerRequestKind, number>(),
);

/** One observation follows a request across admission retries and cancellation. */
export function trackWorkerRequest(
  kind: WorkerRequestKind,
  requestClass: string,
  queuedSignal?: AbortSignal,
): WorkerRequestObservation {
  const label = normalizeWorkerRequestClass(requestClass);
  const reservation = kind === "sqlite_writer" ? reservations.getStore() : undefined;
  const enqueuedAt = performance.now();
  const timing: DiagnosticWorkerRequestFields["timing"] =
    kind === "sqlite_writer" &&
    (detailedTiming ||
      metricsListeners.size > 0 ||
      hasInternalDiagnosticEventInterest("worker.request", true))
      ? { enqueued: enqueuedAt }
      : undefined;
  let startedAt: number | undefined;
  let completed = false;
  const emit = (
    phase: DiagnosticWorkerRequestFields["phase"],
    queueWaitMs?: number,
    durationMs?: number,
  ) => {
    if (!areDiagnosticsEnabledForProcess()) {
      return;
    }
    const queueDepth = queued.get(kind) ?? 0;
    const completedTiming = phase === "completed" ? timing : undefined;
    for (const listener of metricsListeners) {
      try {
        listener(kind, label, phase, queueDepth, queueWaitMs, durationMs, completedTiming);
      } catch {
        // An exporter cannot interrupt worker dispatch or settlement.
      }
    }
    if (!hasInternalDiagnosticEventInterest("worker.request", true)) {
      return;
    }
    emitTrustedDiagnosticEvent({
      type: "worker.request",
      kind,
      requestClass: label,
      phase,
      queueDepth,
      ...(queueWaitMs === undefined ? {} : { queueWaitMs }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(completedTiming ? { timing: completedTiming } : {}),
    });
  };
  const dequeue = () => queued.set(kind, (queued.get(kind) ?? 0) - 1);
  queued.set(kind, (queued.get(kind) ?? 0) + 1);
  emit("queued");
  const observation: WorkerRequestObservation = {
    requestClass: label,
    timing,
    ...(reservation
      ? {
          recordTransactions: (count: number) => {
            reservation.transactionCount = (reservation.transactionCount ?? 0) + count;
          },
        }
      : {}),
    started: (workerThreadId) => {
      if (completed || startedAt !== undefined) {
        return;
      }
      startedAt = performance.now();
      if (reservation) {
        observation.startedAt = startedAt;
        observation.threadId = workerThreadId;
        reservation.active = observation;
        reservation.operations.add(
          reservation.operations.has(label) || reservation.operations.size < 8 ? label : "other",
        );
      }
      if (timing) {
        timing.dispatched = startedAt;
      }
      queuedSignal?.removeEventListener("abort", observation.completed);
      dequeue();
      emit("started", startedAt - enqueuedAt);
    },
    completed: () => {
      if (completed) {
        return;
      }
      completed = true;
      if (reservation?.active === observation) {
        reservation.active = undefined;
      }
      queuedSignal?.removeEventListener("abort", observation.completed);
      if (startedAt === undefined) {
        dequeue();
      }
      emit(
        "completed",
        undefined,
        startedAt === undefined ? undefined : performance.now() - startedAt,
      );
    },
  };
  queuedSignal?.addEventListener("abort", observation.completed, { once: true });
  if (queuedSignal?.aborted) {
    observation.completed();
  }
  return observation;
}
