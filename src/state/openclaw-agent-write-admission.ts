import { channel } from "node:diagnostics_channel";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../infra/sqlite-database-admission-turn.js";
import {
  canShareSqliteDatabaseAdmissions,
  getSqliteDatabaseAdmissionIdentityForPath,
  hasSqliteDatabaseSchemaAdmissionForIdentity,
  getSqliteDatabaseAdmissionSourceForPath,
  prepareSqliteDatabaseAdmissionAsync,
  retainSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import {
  assertExistingDatabaseIdentity,
  assertDatabaseFileIdentity,
  readDatabasePathIdentity,
  readDatabasePathIdentitySync,
  resolveDatabasePathKeyAsync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  withSqliteWorkerReservationObservation,
  type SqliteWorkerReservationObservation,
} from "../infra/worker-request-diagnostics.js";
import { getChildLogger } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runStoreWriterAcquisitions } from "../shared/store-writer-acquisitions.js";
import { isActiveStoreWriter, runQueuedStoreWrite } from "../shared/store-writer-queue.js";
import { shortenHomePath } from "../utils.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  agentDatabaseWriteAdmissionState as admission,
  type AgentDatabaseWriteTiming,
} from "./openclaw-agent-write-admission-state.js";

type ReservationTiming = AgentDatabaseWriteTiming & {
  blockingOperation?: string;
  blockingCaller?: string;
  blockingWorker?: SqliteWorkerReservationObservation;
};

/** Unknown aliases keep invocation order only through discovery and native-turn reservation. */
function acquireAgentDatabaseWriter<T, Prepared>(
  prepared: Prepared | undefined,
  prepare: () => Promise<Prepared>,
  reserve: (prepared: Prepared) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const predecessor = admission.acquisition;
  if (prepared !== undefined && !predecessor) {
    signal?.throwIfAborted();
    return reserve(prepared);
  }
  const acquired = createDeferredCore();
  admission.acquisition = acquired.promise;
  const pending = (async () => {
    try {
      if (predecessor) {
        await predecessor;
      }
      signal?.throwIfAborted();
      const selected = prepared ?? (await prepare());
      // Return the operation inside a value: the acquisition must never await its settlement.
      return { operation: reserve(selected) };
    } finally {
      if (admission.acquisition === acquired.promise) {
        delete admission.acquisition;
      }
      acquired.resolve();
    }
  })();
  return pending.then(({ operation }) => operation);
}

function observeBlockingWriter(storePath: string, observed: ReservationTiming): void {
  const holder = admission.queues.get(storePath)?.holder;
  if (!holder || observed.holderAtEnqueue) {
    return;
  }
  // Retain only attribution, not the holder's timing or its own blocking chain.
  observed.blockingOperation = holder?.operation;
  observed.blockingCaller = holder?.caller;
  observed.blockingWorker = holder?.worker;
  if (holder?.startedAt !== undefined) {
    const active = holder.worker?.active;
    observed.holderAtEnqueue = {
      operation:
        active?.requestClass ??
        holder.operationLabel ??
        holder.caller ??
        holder.operation ??
        "unlabeled",
      threadId: active ? active.threadId : threadId,
      heldMs: Math.max(0, Math.round(performance.now() - (active?.startedAt ?? holder.startedAt))),
    };
  }
}

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
  timing: AgentDatabaseWriteTiming | undefined,
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
      ...(observed.holderAtEnqueue ? { holderAtEnqueue: observed.holderAtEnqueue } : {}),
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
  timing?: AgentDatabaseWriteTiming,
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

/** A selector joins invocation order before discovering its physical writer. */
export function runOpenClawAgentPreparedWriteAdmission<
  Source extends { options: OpenClawAgentDatabaseOptions; identity: DatabasePathIdentity },
  T,
>(
  prepare: () => Promise<Source>,
  run: (
    source: Source,
    identity: DatabasePathIdentity,
    assertCurrent: () => void,
  ) => Promise<T> | T,
  reentrant = false,
  request?: { signal?: AbortSignal; caller?: DirectReservationCaller },
): Promise<T> {
  return acquireAgentDatabaseWriter(
    undefined,
    prepare,
    (source) =>
      runAgentDatabasePathWriteAdmission(
        resolveOpenClawAgentSqlitePath(source.options),
        (identity, assertCurrent) => run(source, identity, assertCurrent),
        reentrant,
        undefined,
        request?.signal,
        request?.caller,
        undefined,
        true,
        source.identity,
      ),
    request?.signal,
  );
}

/** A captured physical actor needs no logical agent or ambient path resolution. */
export function runOpenClawAgentPathWriteAdmission<T>(
  pathname: string,
  run: (identity: DatabasePathIdentity, assertCurrent: () => void) => Promise<T> | T,
  reentrant = false,
  timing?: AgentDatabaseWriteTiming,
  signal?: AbortSignal,
  caller?: DirectReservationCaller,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  return runAgentDatabasePathWriteAdmission(
    pathname,
    run,
    reentrant,
    timing,
    signal,
    caller,
    concurrentBoardReads,
  );
}

async function runAgentDatabasePathWriteAdmission<T>(
  pathname: string,
  run: (identity: DatabasePathIdentity, assertCurrent: () => void) => Promise<T> | T,
  reentrant = false,
  timing?: AgentDatabaseWriteTiming,
  signal?: AbortSignal,
  caller?: DirectReservationCaller,
  concurrentBoardReads?: "transcript-only",
  worker = false,
  preparedIdentity?: DatabasePathIdentity,
): Promise<T> {
  const sharedWorker = worker && canShareSqliteDatabaseAdmissions();
  const admitted = getSqliteDatabaseAdmissionIdentityForPath(pathname);
  let retained =
    canShareSqliteDatabaseAdmissions() &&
    admitted &&
    hasSqliteDatabaseSchemaAdmissionForIdentity(admitted)
      ? retainSqliteDatabaseAdmissionForPath(pathname)
      : undefined;
  const reserve = (identity: DatabasePathIdentity, observed: ReservationTiming) => {
    const storePath = identity.canonicalPath;
    let currentIdentity = identity;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (retained) {
        if (!retained.isCurrent()) {
          throw new Error("Agent database target changed before write admission");
        }
      } else if (!sharedWorker && identity.key.startsWith("file:")) {
        try {
          assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
        } catch (cause) {
          throw new Error("Agent database target changed before write admission", { cause });
        }
      } else if (
        !sharedWorker &&
        readDatabasePathIdentitySync(pathname).canonicalPath !== storePath
      ) {
        throw new Error("Agent database target changed before write admission");
      }
    };
    observeBlockingWriter(storePath, observed);
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
            const queue = admission.queues.get(storePath)!;
            const previousHolder = queue.holder;
            queue.holder = observed;
            try {
              if (worker && !retained) {
                if (identity.key.startsWith("file:")) {
                  try {
                    assertDatabaseFileIdentity(await stat(pathname, { bigint: true }), identity);
                  } catch (cause) {
                    throw new Error("Agent database target changed before write admission", {
                      cause,
                    });
                  }
                } else {
                  currentIdentity = await readDatabasePathIdentity(pathname);
                  if (currentIdentity.canonicalPath !== storePath) {
                    throw new Error("Agent database target changed before write admission");
                  }
                }
                if (sharedWorker) {
                  const prepared = await prepareSqliteDatabaseAdmissionAsync({
                    location: pathname,
                    identity: currentIdentity,
                    expectedIdentity: identity.key.startsWith("file:") ? identity : undefined,
                    assertCurrent: () => signal?.throwIfAborted(),
                  });
                  if (!prepared || prepared.canonicalPath !== storePath) {
                    throw new Error("Agent database target changed before write admission");
                  }
                  currentIdentity = prepared;
                  if (prepared.key.startsWith("file:")) {
                    const source = getSqliteDatabaseAdmissionSourceForPath(pathname);
                    if (
                      !source ||
                      source.identity.key !== prepared.key ||
                      source.identity.birthtime !== prepared.birthtime
                    ) {
                      throw new Error("Agent database target changed before write admission");
                    }
                    retained = retainSqliteDatabaseAdmissionForPath(pathname);
                  }
                }
              }
              signal?.throwIfAborted();
              if (!worker || retained) {
                assertCurrent();
              }
              return await run(currentIdentity, assertCurrent);
            } finally {
              queue.holder = previousHolder;
            }
          },
          timing: observed,
          signal,
        }),
      [],
      signal,
      retained ? undefined : { readIdentities: new Map([[pathname, identity]]) },
    );
  };
  try {
    if (
      preparedIdentity?.key.startsWith("file:") &&
      retained &&
      (retained.identity.key !== preparedIdentity.key ||
        retained.identity.birthtime !== preparedIdentity.birthtime)
    ) {
      throw new Error("Agent database target changed before write admission");
    }
    return await observeWriteAdmission(
      "direct",
      timing,
      (observed) => {
        observeBlockingWriter(pathname, observed);
        // An active foreground writer must finish before cold discovery can settle.
        // Borrow its retained identity rather than waiting behind that discovery.
        const reentrantIdentity =
          reentrant &&
          retained &&
          !admission.queues.get(retained.identity.canonicalPath)?.holder?.worker &&
          isActiveStoreWriter(
            admission.queues,
            retained.identity.canonicalPath,
            concurrentBoardReads ? new Set(["transcript"]) : undefined,
          )
            ? retained.identity
            : undefined;
        // A multi-store acquisition already owns invocation order for every captured path.
        const capturedIdentity = preparedIdentity ?? reentrantIdentity;
        return capturedIdentity
          ? reserve(retained?.identity ?? capturedIdentity, observed)
          : acquireAgentDatabaseWriter(
              retained?.identity,
              () => readDatabasePathIdentity(pathname),
              (identity) => reserve(identity, observed),
              signal,
            );
      },
      caller,
    );
  } finally {
    retained?.release();
  }
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export async function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: AgentDatabaseWriteTiming,
  signal?: AbortSignal,
  priority?: "background",
  caller?: WorkerReservationCaller,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  if (priority === "background") {
    const storePath = await resolveDatabasePathKeyAsync(resolveOpenClawAgentSqlitePath(options));
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
      runAgentDatabasePathWriteAdmission(
        resolveOpenClawAgentSqlitePath(options),
        () => withSqliteWorkerReservationObservation(worker, run),
        true,
        observed,
        signal,
        undefined,
        concurrentBoardReads,
        true,
      ),
    caller,
    worker,
  );
}

/** Board authority remains exclusive with mutations, but not certified transcript appends. */
export function runOpenClawAgentBoardReadAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  snapshotOnly = false,
): Promise<T> {
  // Display snapshots read committed rows; document and capability consumers
  // retain the FIFO and check current grants at their own effect boundary.
  if (snapshotOnly) {
    return run();
  }
  const pathname = resolveOpenClawAgentSqlitePath(options);
  return acquireAgentDatabaseWriter(
    undefined,
    () => readDatabasePathIdentity(pathname),
    (identity) =>
      runWithSqliteDatabaseAdmissionTurn(
        [pathname],
        () =>
          runQueuedStoreWrite({
            queues: admission.queues,
            storePath: identity.canonicalPath,
            label: "agent database board read admission",
            keys: ["board"],
            reentrant: !admission.queues.get(identity.canonicalPath)?.holder?.worker,
            fn: run,
          }),
        [],
        undefined,
        hasSqliteDatabaseSchemaAdmissionForIdentity(identity)
          ? undefined
          : { readIdentities: new Map([[pathname, identity]]) },
      ),
  );
}

/** Compose the existing foreground queues without inverting inherited acquisition order. */
export async function runOpenClawAgentWriteAdmissions<T>(
  options: readonly (OpenClawAgentDatabaseOptions & { readIdentity?: DatabasePathIdentity })[],
  run: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const requested = new Map(
    options.map((option) => [resolveOpenClawAgentSqlitePath(option), option]),
  );
  const inherited = [...admission.queues.keys()].filter((pathname) =>
    isActiveStoreWriter(admission.queues, pathname),
  );
  const identities = new Map<string, DatabasePathIdentity>();
  const missing: string[] = [];
  for (const pathname of new Set([...requested.keys(), ...inherited])) {
    const prepared = requested.get(pathname)?.readIdentity;
    const admitted = prepared ? undefined : getSqliteDatabaseAdmissionIdentityForPath(pathname);
    const retained =
      canShareSqliteDatabaseAdmissions() &&
      admitted &&
      hasSqliteDatabaseSchemaAdmissionForIdentity(admitted)
        ? retainSqliteDatabaseAdmissionForPath(pathname)
        : undefined;
    const identity = prepared ?? retained?.identity;
    retained?.release();
    if (identity) {
      identities.set(pathname, identity);
    } else {
      missing.push(pathname);
    }
  }
  const reserve = (captured: ReadonlyMap<string, DatabasePathIdentity>): Promise<T> => {
    let selected = requested;
    if (selected.size > 1) {
      const physicalKey = (pathname: string) => {
        const identity = captured.get(pathname)!;
        return `${identity.key}:${identity.birthtime ?? ""}`;
      };
      // Borrow the held queue's spelling when multiple locators name the same file.
      const representatives = new Map(
        inherited.map((pathname) => [physicalKey(pathname), pathname]),
      );
      const physical = new Map<
        string,
        OpenClawAgentDatabaseOptions & { readIdentity?: DatabasePathIdentity }
      >();
      for (const [pathname, option] of selected) {
        const identity = physicalKey(pathname);
        const representative = representatives.get(identity) ?? pathname;
        representatives.set(identity, representative);
        physical.set(representative, { ...option, path: representative });
      }
      selected = physical;
    }
    const paths = [...selected.keys()].toSorted();
    // A nested reader may share one foreground FIFO, never a reserved worker transaction.
    const conflicting = paths.find(
      (pathname) =>
        inherited.includes(pathname) &&
        (paths.length !== 1 || admission.queues.get(pathname)?.holder?.worker),
    );
    if (conflicting !== undefined) {
      const holder = admission.queues.get(conflicting)?.holder;
      const database = shortenHomePath(conflicting);
      // Keep the refusing admission self-identifying even when the RPC drops its stack.
      const facts = {
        database: database.length > 160 ? `...${database.slice(-157)}` : database,
        operation: holder?.operation ?? "unknown",
        ...(holder?.caller ? { caller: holder.caller } : {}),
        ...(holder?.worker ? { workerOperations: [...holder.worker.operations] } : {}),
        threadId,
        isMainThread,
        ...(holder?.startedAt !== undefined
          ? { ageMs: Math.max(0, Math.round(performance.now() - holder.startedAt)) }
          : {}),
      };
      throw new Error(
        `Session read batch cannot reenter an active SQLite writer admission: ${JSON.stringify(facts)}`,
      );
    }
    if (paths.some((pathname) => inherited.some((held) => held > pathname))) {
      throw new Error("Session read batch would invert inherited SQLite writer admission order");
    }
    return runWithSqliteDatabaseAdmissionTurn(
      paths,
      () =>
        runStoreWriterAcquisitions<T>((index, next) => {
          const pathname = paths[index];
          return pathname === undefined
            ? Promise.resolve().then(run)
            : observeWriteAdmission("ordered-read", undefined, (timing) => {
                const option = selected.get(pathname)!;
                if (!option.readIdentity) {
                  return runAgentDatabasePathWriteAdmission(
                    pathname,
                    next,
                    true,
                    timing,
                    signal,
                    undefined,
                    undefined,
                    false,
                    captured.get(pathname),
                  );
                }
                if (option.readIdentity.canonicalPath !== pathname) {
                  throw new Error("Prepared session read lost its physical FIFO target");
                }
                observeBlockingWriter(pathname, timing);
                return runQueuedStoreWrite({
                  queues: admission.queues,
                  storePath: pathname,
                  label: "agent database ordered read admission",
                  reentrant: true,
                  fn: next,
                  timing,
                  signal,
                });
              });
        }),
      [],
      signal,
      {
        readIdentities: new Map(
          [...selected].flatMap(([pathname, option]) => {
            const identity = option.readIdentity ?? captured.get(pathname)!;
            return option.readIdentity || !hasSqliteDatabaseSchemaAdmissionForIdentity(identity)
              ? [[pathname, identity] as const]
              : [];
          }),
        ),
      },
    );
  };
  return acquireAgentDatabaseWriter(
    missing.length === 0 ? identities : undefined,
    async () => {
      await Promise.all(
        missing.map(async (pathname) => {
          identities.set(pathname, await readDatabasePathIdentity(pathname));
        }),
      );
      return identities;
    },
    reserve,
    signal,
  );
}
