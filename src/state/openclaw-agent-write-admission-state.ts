import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertStoreWriterReleased, type StoreWriterQueue } from "../shared/store-writer-queue.js";

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
export const agentDatabaseWriteAdmissionState = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<string, StoreWriterQueue>(),
    workers: new Map<string, object>(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = agentDatabaseWriteAdmissionState.queues;

export function assertOpenClawAgentWriterReleased(operation: string): void {
  assertStoreWriterReleased(SQLITE_SESSION_WRITER_QUEUES, operation);
}
