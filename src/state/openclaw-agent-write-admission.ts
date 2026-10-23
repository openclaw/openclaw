import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  withSqliteWorkerReservationObservation,
  type SqliteWorkerReservationObservation,
} from "../infra/worker-request-diagnostics.js";
import { getChildLogger } from "../logging/logger.js";
import { runStoreWriterAcquisitions } from "../shared/store-writer-acquisitions.js";
import {
  isActiveStoreWriter,
  runQueuedStoreWrite,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { agentDatabaseWriteAdmissionState as admission } from "./openclaw-agent-write-admission-state.js";

type ReservationTiming = NonNullable<
  NonNullable<ReturnType<typeof admission.queues.get>>["holder"]
> & {
  blockingOperation?: string;
  blockingCaller?: string;
  blockingWorker?: SqliteWorkerReservationObservation;
};

const reservationDiagnostics = channel("openclaw.agent-database.reservation");
type WorkerReservationCaller = "session-reclamation.close";
type DirectReservationCaller =
  | "session-manager.write"
  | "session-manager.note"
  | "session-actor.command"
  | "history.model-context"
  | "history.hydration";

function observeWriteAdmission<T>(
  operation: "direct" | "worker" | "ordered-read",
  timing: StoreWriterTiming | undefined,
  run: (timing: ReservationTiming) => Promise<T>,
  caller?: DirectReservationCaller | WorkerReservationCaller,
  worker?: SqliteWorkerReservationObservation,
): Promise<T> {
  const observed: ReservationTiming = timing ?? {};
  observed.operation ??= operation;
  observed.caller ??= caller;
  observed.worker ??= worker;
  // Supplied timing belongs to the session-write diagnostic owner, or to an
  // enclosing observer here. Neither route should emit a second holder warning.
  if (timing) {
    return run(observed);
  }
  const enqueuedAt = performance.now();
  const report = (outcome: "ok" | "error") => {
    if (
      observed.reentrant !== false ||
      observed.startedAt === undefined ||
      observed.finishedAt === undefined ||
      (observed.finishedAt - enqueuedAt < 1_000 && !reservationDiagnostics.hasSubscribers)
    ) {
      return;
    }
    const completedAt = performance.now();
    const fields = {
      operation,
      ...(caller ? { caller } : {}),
      ...(worker
        ? {
            workerOperations: [...worker.operations],
            ...(worker.transactionCount !== undefined
              ? { transactionCount: worker.transactionCount }
              : {}),
          }
        : {}),
      ...(observed.blockingOperation ? { blockingOperation: observed.blockingOperation } : {}),
      ...(observed.blockingCaller ? { blockingCaller: observed.blockingCaller } : {}),
      ...(observed.blockingWorker
        ? { blockingWorkerOperations: [...observed.blockingWorker.operations] }
        : {}),
      outcome,
      pid: process.pid,
      threadId,
      isMainThread,
      reentrant: false,
      elapsedMs: Math.round(completedAt - enqueuedAt),
      queueWaitMs: Math.round(observed.startedAt - enqueuedAt),
      writerExecutionMs: Math.round(observed.finishedAt - observed.startedAt),
      completionDelayMs: Math.round(completedAt - observed.finishedAt),
    };
    if (reservationDiagnostics.hasSubscribers) {
      reservationDiagnostics.publish(fields);
    }
    if (observed.finishedAt - enqueuedAt < 1_000) {
      return;
    }
    try {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        fields,
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
  caller?: DirectReservationCaller,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  return runOpenClawAgentPathWriteAdmission(
    resolveOpenClawAgentSqlitePath(options),
    run,
    reentrant,
    timing,
    signal,
    caller,
    concurrentBoardReads,
  );
}

/** A captured physical actor needs no logical agent or ambient path resolution. */
export function runOpenClawAgentPathWriteAdmission<T>(
  pathname: string,
  run: (identity: DatabasePathIdentity, assertCurrent: () => void) => Promise<T> | T,
  reentrant = false,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
  caller?: DirectReservationCaller,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  const identity = readDatabasePathIdentitySync(pathname);
  const storePath = identity.canonicalPath;
  const assertCurrent = () => {
    if (identity.key.startsWith("file:")) {
      try {
        assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
      } catch (cause) {
        throw new Error("Agent database target changed before write admission", { cause });
      }
    } else if (readDatabasePathIdentitySync(pathname).canonicalPath !== storePath) {
      throw new Error("Agent database target changed before write admission");
    }
  };
  return observeWriteAdmission(
    "direct",
    timing,
    (observed) => {
      const holder = admission.queues.get(storePath)?.holder;
      // Retain only attribution, not the holder's timing or its own blocking chain.
      observed.blockingOperation = holder?.operation;
      observed.blockingCaller = holder?.caller;
      observed.blockingWorker = holder?.worker;
      // Cold tasks may need a host write before releasing their admission turn.
      return runWithSqliteDatabaseAdmissionTurn(
        [pathname],
        () =>
          runQueuedStoreWrite({
            queues: admission.queues,
            storePath,
            label: "agent database write admission",
            keys: concurrentBoardReads ? ["transcript"] : undefined,
            // Worker callbacks inherit their parent's async context, but not its native
            // writer lock. Their foreground writes must queue, never reenter that owner.
            reentrant: reentrant && !admission.queues.get(storePath)?.holder?.worker,
            fn: async () => {
              assertCurrent();
              const queue = admission.queues.get(storePath)!;
              const previousHolder = queue.holder;
              queue.holder = observed;
              try {
                return await run(identity, assertCurrent);
              } finally {
                queue.holder = previousHolder;
              }
            },
            timing: observed,
            signal,
          }),
        [],
        signal,
      );
    },
    caller,
  );
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export async function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
  priority?: "background",
  caller?: WorkerReservationCaller,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  if (priority === "background") {
    const storePath = readDatabasePathIdentitySync(
      resolveOpenClawAgentSqlitePath(options),
    ).canonicalPath;
    // Rebuildable work waits outside the FIFO until existing foreground work drains.
    // Once admitted, its bounded transaction settles under the ordinary writer rules.
    let draining: Promise<void> | null | undefined;
    while ((draining = admission.queues.get(storePath)?.drainPromise)) {
      await racePromiseWithAbortSignal(draining, signal, (aborted) => aborted.reason);
    }
  }
  const worker: SqliteWorkerReservationObservation = { operations: new Set() };
  return observeWriteAdmission(
    "worker",
    timing,
    (observed) =>
      runOpenClawAgentWriteAdmission(
        options,
        () => withSqliteWorkerReservationObservation(worker, run),
        true,
        observed,
        signal,
        undefined,
        concurrentBoardReads,
      ),
    caller,
    worker,
  );
}

/** Board authority remains exclusive with mutations, but not certified transcript appends. */
export function runOpenClawAgentBoardReadAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
): Promise<T> {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const storePath = readDatabasePathIdentitySync(pathname).canonicalPath;
  return runWithSqliteDatabaseAdmissionTurn([pathname], () =>
    runQueuedStoreWrite({
      queues: admission.queues,
      storePath,
      label: "agent database board read admission",
      keys: ["board"],
      reentrant: !admission.queues.get(storePath)?.holder?.worker,
      fn: run,
    }),
  );
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
        (!reentrant || paths.length !== 1 || admission.queues.get(pathname)?.holder?.worker),
    )
  ) {
    throw new Error("Session read batch cannot reenter an active SQLite writer admission");
  }
  if (paths.some((pathname) => inherited.some((held) => held > pathname))) {
    throw new Error("Session read batch would invert inherited SQLite writer admission order");
  }
  return await runWithSqliteDatabaseAdmissionTurn(
    paths,
    () =>
      runStoreWriterAcquisitions((index, next) => {
        const pathname = paths[index];
        return pathname === undefined
          ? Promise.resolve().then(run)
          : observeWriteAdmission("ordered-read", undefined, (timing) =>
              runOpenClawAgentWriteAdmission(selected.get(pathname)!, next, true, timing, signal),
            );
      }),
    [],
    signal,
  );
}
