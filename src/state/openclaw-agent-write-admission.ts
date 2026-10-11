import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import type { SqliteWorkerEphemeralTarget } from "../infra/sqlite-worker-contract.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { getChildLogger } from "../logging/logger.js";
import {
  isActiveStoreWriter,
  runQueuedStoreWrite,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { agentDatabaseWriteAdmissionState as admission } from "./openclaw-agent-write-admission-state.js";

function observeWriteAdmission<T>(
  operation: "direct" | "worker" | "ordered-read",
  timing: StoreWriterTiming | undefined,
  run: (timing: StoreWriterTiming) => Promise<T>,
): Promise<T> {
  // Supplied timing belongs to the session-write diagnostic owner, or to an
  // enclosing observer here. Neither route should emit a second holder warning.
  if (timing) {
    return run(timing);
  }
  const observed: StoreWriterTiming = {};
  const enqueuedAt = performance.now();
  const report = (outcome: "ok" | "error") => {
    if (
      observed.reentrant !== false ||
      observed.startedAt === undefined ||
      observed.finishedAt === undefined ||
      observed.finishedAt - observed.startedAt < 1_000
    ) {
      return;
    }
    const completedAt = performance.now();
    try {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        {
          operation,
          outcome,
          pid: process.pid,
          threadId,
          isMainThread,
          reentrant: false,
          elapsedMs: Math.round(completedAt - enqueuedAt),
          queueWaitMs: Math.round(observed.startedAt - enqueuedAt),
          writerExecutionMs: Math.round(observed.finishedAt - observed.startedAt),
          completionDelayMs: Math.round(completedAt - observed.finishedAt),
        },
        "slow agent database reservation",
      );
    } catch {
      // Diagnostics must not replace the settled result or its original failure.
    }
  };
  return run(observed).then(
    (value) => {
      report("ok");
      return value;
    },
    (error: unknown) => {
      report("error");
      throw error;
    },
  );
}

export function runOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: (identity: DatabasePathIdentity, assertCurrent: () => void) => Promise<T> | T,
  reentrant = false,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const identity = readDatabasePathIdentitySync(pathname);
  const storePath = identity.canonicalPath;
  const assertCurrent = () => {
    const current = readDatabasePathIdentitySync(pathname);
    if (
      current.canonicalPath !== storePath ||
      (identity.key.startsWith("file:") &&
        (current.key !== identity.key || current.birthtime !== identity.birthtime))
    ) {
      throw new Error("Agent database target changed before write admission");
    }
  };
  return observeWriteAdmission("direct", timing, (observed) =>
    runQueuedStoreWrite({
      queues: admission.queues,
      storePath,
      label: "agent database write admission",
      // Worker callbacks inherit their parent's async context, but not its native
      // writer lock. Their foreground writes must queue, never reenter that owner.
      reentrant: reentrant && !admission.workers.has(storePath),
      fn: async () => {
        assertCurrent();
        return await run(identity, assertCurrent);
      },
      timing: observed,
      signal,
    }),
  );
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export function runOpenClawAgentWorkerWrite<T>(
  options:
    | OpenClawAgentDatabaseOptions
    | { target: Readonly<SqliteWorkerEphemeralTarget>; assertCurrent(): void },
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  return observeWriteAdmission("worker", timing, (observed) => {
    if ("target" in options) {
      const { handle, incarnation } = options.target;
      return runQueuedStoreWrite({
        queues: admission.queues,
        storePath: `ephemeral:${handle}:${incarnation}`,
        label: "incognito agent database write admission",
        reentrant: false,
        fn: async () => {
          options.assertCurrent();
          return run();
        },
        timing: observed,
        signal,
      });
    }
    return runOpenClawAgentWriteAdmission(
      options,
      async ({ canonicalPath: storePath }) => {
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
      observed,
      signal,
    );
  });
}

/** Compose the existing foreground queues without inverting inherited acquisition order. */
export async function runOpenClawAgentWriteAdmissions<T>(
  options: readonly OpenClawAgentDatabaseOptions[],
  run: () => Promise<T> | T,
  reentrant = false,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const selected = new Map(
    options.map((option) => [resolveOpenClawAgentSqlitePath(option), option]),
  );
  const paths = [...selected.keys()].toSorted();
  const inherited = [...admission.queues.keys()].filter((pathname) =>
    isActiveStoreWriter(admission.queues, pathname),
  );
  // A nested reader may share one foreground FIFO, never a reserved worker transaction.
  if (
    paths.some(
      (pathname) =>
        inherited.includes(pathname) &&
        (!reentrant || paths.length !== 1 || admission.workers.has(pathname)),
    )
  ) {
    throw new Error("Session read batch cannot reenter an active SQLite writer admission");
  }
  if (paths.some((pathname) => inherited.some((held) => held > pathname))) {
    throw new Error("Session read batch would invert inherited SQLite writer admission order");
  }
  const acquire = (index: number): Promise<T> => {
    const pathname = paths[index];
    return pathname === undefined
      ? Promise.resolve().then(run)
      : observeWriteAdmission("ordered-read", undefined, (timing) =>
          runOpenClawAgentWriteAdmission(
            selected.get(pathname)!,
            () => acquire(index + 1),
            true,
            timing,
            signal,
          ),
        );
  };
  return await acquire(0);
}
