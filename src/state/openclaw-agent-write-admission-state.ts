import type { SqliteWorkerReservationObservation } from "../infra/worker-request-diagnostics.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  assertStoreWriterReleased,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";

export type AgentDatabaseWriteTiming = StoreWriterTiming & {
  operation?: "direct" | "worker" | "ordered-read";
  operationLabel?: string;
  caller?: string;
  worker?: SqliteWorkerReservationObservation;
  /** The active operation observed when this request entered the queue, not every intervening writer. */
  holderAtEnqueue?: { operation: string; threadId?: number; heldMs: number };
};

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
export const agentDatabaseWriteAdmissionState = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<
      string,
      StoreWriterQueue & {
        holder?: AgentDatabaseWriteTiming;
      }
    >(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = agentDatabaseWriteAdmissionState.queues;

export function assertOpenClawAgentWriterReleased(operation: string): void {
  assertStoreWriterReleased(SQLITE_SESSION_WRITER_QUEUES, operation);
}
