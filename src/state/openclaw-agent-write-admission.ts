import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  isActiveStoreWriter,
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
    signal,
  );
}

/** Compose the existing foreground queues without inverting inherited acquisition order. */
export async function runOpenClawAgentWriteAdmissions<T>(
  options: readonly OpenClawAgentDatabaseOptions[],
  run: () => Promise<T> | T,
): Promise<T> {
  const selected = new Map(
    options.map((option) => [resolveOpenClawAgentSqlitePath(option), option]),
  );
  const paths = [...selected.keys()].toSorted();
  const inherited = [...admission.queues.keys()].filter((pathname) =>
    isActiveStoreWriter(admission.queues, pathname),
  );
  if (paths.some((pathname) => inherited.includes(pathname))) {
    throw new Error("Session read batch cannot reenter an active SQLite writer admission");
  }
  if (paths.some((pathname) => inherited.some((held) => held > pathname))) {
    throw new Error("Session read batch would invert inherited SQLite writer admission order");
  }
  const acquire = (index: number): Promise<T> => {
    const pathname = paths[index];
    return pathname === undefined
      ? Promise.resolve().then(run)
      : runOpenClawAgentWriteAdmission(selected.get(pathname)!, () => acquire(index + 1), true);
  };
  return await acquire(0);
}
