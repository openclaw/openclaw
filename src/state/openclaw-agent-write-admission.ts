import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
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
  signal?: AbortSignal,
): Promise<T> {
  return runAgentWriteAdmission(options, () => run(), reentrant, timing, signal);
}

function runAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: (storePath: string) => Promise<T> | T,
  reentrant: boolean,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  const storePath = readDatabasePathIdentitySync(
    resolveOpenClawAgentSqlitePath(options),
  ).canonicalPath;
  return runQueuedStoreWrite({
    queues: admission.queues,
    storePath,
    label: "agent database write admission",
    // Worker callbacks inherit their parent's async context, but not its native
    // writer lock. Their foreground writes must queue, never reenter that owner.
    reentrant: reentrant && !admission.workers.has(storePath),
    fn: async () => await run(storePath),
    timing,
    signal,
  });
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  return runAgentWriteAdmission(
    options,
    async (storePath) => {
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
    signal,
  );
}
