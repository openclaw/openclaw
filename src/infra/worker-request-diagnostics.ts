import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithAsyncStore } from "../shared/async-store.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasInternalDiagnosticEventInterest } from "./diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "./diagnostic-events.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import {
  classifySqliteWorkerExecute,
  sqliteWorkerRequestClasses,
} from "./sqlite-worker-request-class.js";
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
  timing?: DiagnosticWorkerRequestFields["timing"];
  recordTransactions?(count: number): void;
  started(this: void): void;
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

// Exact owner commands only: SDK callers may supply private suffixes.
const coreCommands = new Set([
  "devicePairing.lookup",
  "devicePairing.list",
  "devicePairing.updateMetadata",
  "devicePairing.updatePresence",
  "devicePairing.verifyToken",
  "devicePairing.ensureToken",
  "session.actor.read",
  "session.actor.acceptInput",
  "session.actor.adoptRun",
  "session.actor.appendToolResult",
  "session.actor.appendTranscriptEvent",
  "session.actor.completeTurn",
  "session.actor.deliveryPending",
  "session.actor.deliverySettled",
  "session.actor.patch",
  "session.entry.read",
  "session.entry.patch.prepare",
  "session.entry.patch.commit",
  "session.entry.replacements.prepare",
  "session.entry.replacements.commit",
  "session.lifecycle.project",
  "session.maintenance.metadata",
  "session.maintenance.prepare",
  "session.maintenance.finalize",
  "session.maintenance.size",
  "session.rowTranscript.backfill",
  "usageCache.writeRollup",
  "usageCache.prune",
  "trajectory.events.append",
  "trajectory.retention.begin",
  "trajectory.retention.delete",
  "session.pendingInputs.read",
  "session.pendingInputs.mutate",
  "session.turn.prepare",
  "session.turn.commit",
  "transcript.prepare",
  "transcript.commit",
]);

const projectionCommands = new Map([
  ["preflight", "transcript-projection.preflight"],
  ["sweep", "transcript-projection.sweep"],
  ["claim", "transcript-projection.claim"],
  ["deleteChunk", "transcript-projection.deleteChunk"],
  ["appendChunk", "transcript-projection.appendChunk"],
  ["finalize", "transcript-projection.finalize"],
]);
const projectionModuleSuffixes = [
  "/config/sessions/session-transcript-projection-publication.worker.js",
  "/config/sessions/session-transcript-projection-publication.worker.ts",
];

const requestPrefixes = [
  ["pluginState.", "plugin_state"],
  ["session.history.", "transcript_read"],
  ["trajectory.", "transcripts"],
  ["session.transcript.", "transcripts"],
  ["transcripts.", "transcripts"],
  ["session.", "sessions"],
  ["cron.", "cron"],
] as const;

export function classifyWorkerRequest(commandType: unknown, commandInput?: unknown): string {
  if (typeof commandType !== "string") {
    return "execute";
  }
  if (coreCommands.has(commandType)) {
    return commandType;
  }
  if (commandType === "auth-profile-rows") {
    return "auth_profiles";
  }
  if (commandType === "database.domain.execute" || commandType === "database.domain.publish") {
    const publication = isRecord(commandInput) ? commandInput : undefined;
    const inner = publication && isRecord(publication.command) ? publication.command : undefined;
    const moduleUrl = publication?.moduleUrl;
    // Bare commands such as claim also belong to other owners. Never log their module paths.
    if (
      commandType === "database.domain.publish" &&
      typeof moduleUrl === "string" &&
      typeof inner?.type === "string" &&
      projectionModuleSuffixes.some((suffix) => moduleUrl.endsWith(suffix))
    ) {
      const projection = projectionCommands.get(inner.type);
      if (projection) {
        return projection;
      }
    }
    const label = inner ? classifyWorkerRequest(inner.type) : "execute";
    return label === "execute" ? "domain_execute" : label;
  }
  for (const [prefix, requestClass] of requestPrefixes) {
    if (commandType.startsWith(prefix)) {
      return requestClass;
    }
  }
  return classifySqliteWorkerExecute(commandType);
}

const queued = resolveGlobalSingleton(
  Symbol.for("openclaw.workerRequestQueueDepth"),
  () => new Map<WorkerRequestKind, number>(),
);

const requestClasses = new Set([
  ...coreCommands,
  ...projectionCommands.values(),
  ...sqliteWorkerRequestClasses,
  ...requestPrefixes.map(([, requestClass]) => requestClass),
  "task",
  "open",
  "close",
  "execute",
  "domain_execute",
  "auth_profiles",
]);

/** One observation follows a request across admission retries and cancellation. */
export function trackWorkerRequest(
  kind: WorkerRequestKind,
  requestClass: string,
  queuedSignal?: AbortSignal,
): WorkerRequestObservation {
  const label = requestClasses.has(requestClass) ? requestClass : "other";
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
    timing,
    ...(reservation
      ? {
          recordTransactions: (count: number) => {
            reservation.transactionCount = (reservation.transactionCount ?? 0) + count;
          },
        }
      : {}),
    started: () => {
      if (completed || startedAt !== undefined) {
        return;
      }
      startedAt = performance.now();
      if (reservation) {
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
