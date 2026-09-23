import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  runQueuedStoreWrite,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<string, StoreWriterQueue>(),
    workers: new Map<string, object>(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = admission.queues;

export function runOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T> | T,
  reentrant = false,
  timing?: StoreWriterTiming,
): Promise<T> {
  const storePath = resolveOpenClawAgentSqlitePath(options);
  return runQueuedStoreWrite({
    queues: admission.queues,
    storePath,
    label: "agent database write admission",
    // Worker callbacks inherit their parent's async context, but not its native
    // writer lock. Their foreground writes must queue, never reenter that owner.
    reentrant: reentrant && !admission.workers.has(storePath),
    fn: async () => await run(),
    timing,
  });
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
): Promise<T> {
  const storePath = resolveOpenClawAgentSqlitePath(options);
  return runOpenClawAgentWriteAdmission(
    options,
    async () => {
      const owner = {};
      admission.workers.set(storePath, owner);
      try {
        return await run();
      } finally {
        if (admission.workers.get(storePath) === owner) {
          admission.workers.delete(storePath);
        }
      }
    },
    true,
    timing,
  );
}
