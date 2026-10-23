import type { SqliteWorkerReservationObservation } from "../infra/worker-request-diagnostics.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  assertStoreWriterReleased,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
export const agentDatabaseWriteAdmissionState = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<
      string,
      StoreWriterQueue & {
        holder?: StoreWriterTiming & {
          operation?: "direct" | "worker" | "ordered-read";
          caller?: string;
          worker?: SqliteWorkerReservationObservation;
        };
      }
    >(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = agentDatabaseWriteAdmissionState.queues;

export function assertOpenClawAgentWriterReleased(operation: string): void {
  assertStoreWriterReleased(SQLITE_SESSION_WRITER_QUEUES, operation);
}
