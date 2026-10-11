import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasInternalDiagnosticEventInterest } from "./diagnostic-event-listener-presence.js";
import { emitTrustedDiagnosticEvent } from "./diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import {
  classifySqliteWorkerExecute,
  sqliteWorkerRequestClasses,
} from "./sqlite-worker-request-class.js";
import type { WorkerRequestKind } from "./worker-request-kind.js";

export type WorkerRequestObservation = { started(): void; completed(): void };

const requestPrefixes = [
  ["pluginState.", "plugin_state"],
  ["session.history.", "transcript_read"],
  ["trajectory.", "transcripts"],
  ["session.transcript.", "transcripts"],
  ["transcripts.", "transcripts"],
  ["session.", "sessions"],
  ["cron.", "cron"],
] as const;

export function classifyWorkerRequest(commandType: PropertyKey): string {
  if (typeof commandType !== "string") {
    return "execute";
  }
  if (commandType === "auth-profile-rows") {
    return "auth_profiles";
  }
  if (commandType === "database.domain.execute") {
    return "domain_execute";
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
  const enqueuedAt = performance.now();
  let startedAt: number | undefined;
  let completed = false;
  const emit = (
    phase: DiagnosticWorkerRequestFields["phase"],
    timing: Pick<DiagnosticWorkerRequestFields, "queueWaitMs" | "durationMs"> = {},
  ) => {
    if (!hasInternalDiagnosticEventInterest("worker.request")) {
      return;
    }
    emitTrustedDiagnosticEvent({
      type: "worker.request",
      kind,
      requestClass: label,
      phase,
      queueDepth: queued.get(kind) ?? 0,
      ...timing,
    });
  };
  const dequeue = () => queued.set(kind, (queued.get(kind) ?? 0) - 1);
  queued.set(kind, (queued.get(kind) ?? 0) + 1);
  emit("queued");
  const observation = {
    started: () => {
      if (completed || startedAt !== undefined) {
        return;
      }
      startedAt = performance.now();
      queuedSignal?.removeEventListener("abort", observation.completed);
      dequeue();
      emit("started", { queueWaitMs: startedAt - enqueuedAt });
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
        startedAt === undefined ? {} : { durationMs: performance.now() - startedAt },
      );
    },
  };
  queuedSignal?.addEventListener("abort", observation.completed, { once: true });
  if (queuedSignal?.aborted) {
    observation.completed();
  }
  return observation;
}
