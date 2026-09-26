/** Public cron store load/save API backed entirely by shared SQLite state. */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { runCronRuntimeMutation } from "./service/runtime-mutation.js";
import { cronStoreKey } from "./store/key.js";
import { restoreCronLoadError } from "./store/load-error.js";
import { loadCronStoreFromDatabase } from "./store/load.kernel.js";
import { resolveCronJobsStorePath } from "./store/paths.js";
import {
  deleteCronQuarantinedJobsFromDatabase,
  saveCronQuarantinedJobs,
} from "./store/quarantine.js";
import { assertCronStoreCanPersist, readCronJobsFingerprint } from "./store/row-codec.js";
import type { CronJobFamilyIdentity } from "./store/row-codec.js";
import { CronJobsStoreChangedError, restoreCronSaveError } from "./store/save-error.js";
import type {
  CronStoreSaveWorkerOperations,
  CronStoreWriteResult,
} from "./store/save-worker.types.js";
import {
  isCronRuntimeOnlySave,
  prepareCronStoreChanges,
  replaceCronStoreRowsInDatabase,
  saveCronStoreChangesInDatabase,
  saveCronStoreInDatabase,
} from "./store/save.kernel.js";
import type { CronStoreChangesOptions, CronStoreSaveOptions } from "./store/save.types.js";
import type { CronStoreTransactionHooks } from "./store/transaction-hooks.types.js";
import type { LoadedCronStore } from "./store/types.js";
import type { CronStoreFile } from "./types.js";
export { resolveCronJobsStorePath, resolveCronJobsStorePathFromConfig } from "./store/paths.js";
export { loadCronJobsStoreWithConfigJobsReadOnly } from "./store/read-only.js";
export { CronJobsStoreChangedError } from "./store/save-error.js";
export type {
  CronConfigJobRuntimeEntry,
  CronQuarantinedJob,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "./store/types.js";
export { loadCronQuarantinedJobs, saveCronQuarantinedJobs } from "./store/quarantine.js";

const MAX_TRACKED_CRON_STORE_REVISIONS = 64;
// Stale receipts must never equal a nonnegative publication fact, even after eviction.
const STALE_CRON_STORE_REVISION = -1;
const cronStoreRevisions = new Map<string, number>();
let nextCronStoreRevision = 0;

/** Reads the process-local committed revision for one canonical SQLite partition. */
export function getCronJobsStoreRevision(storePath: string): number {
  // Eviction must not resurrect a snapshot's earlier revision.
  return cronStoreRevisions.get(cronStoreKey(storePath)) ?? nextCronStoreRevision;
}

export function noteCronJobsStoreCommit(storeKey: string): void {
  // A bounded monotonic fact invalidates sibling service snapshots without
  // polling SQLite or discarding the current scheduler's transient run state.
  cronStoreRevisions.delete(storeKey);
  cronStoreRevisions.set(storeKey, ++nextCronStoreRevision);
  pruneMapToMaxSize(cronStoreRevisions, MAX_TRACKED_CRON_STORE_REVISIONS);
}

/** Loads cron jobs plus config/runtime sidecars from the SQLite-backed store. */
export async function loadCronJobsStoreWithConfigJobs(storePath: string): Promise<LoadedCronStore> {
  const storeKey = cronStoreKey(storePath);
  const context = captureOpenClawStateWorkerContext();
  let received = false;
  try {
    return await runOpenClawStateWorkerOperation(context, async (scope) => {
      const result = await scope.execute({ type: "cron.loadMutable", input: { storeKey } });
      received = true;
      for (let index = 0; index < result.repairCommits; index += 1) {
        noteCronJobsStoreCommit(storeKey);
      }
      if (!result.ok) {
        // Coordinator cleanup can fail after COMMIT but before a repair is reported.
        if (result.repairCommits === 0) {
          noteCronJobsStoreCommit(storeKey);
        }
        throw restoreCronLoadError(result.error);
      }
      return result.loaded;
    });
  } catch (error) {
    // An unavailable result cannot certify that no repair committed.
    if (!received) {
      noteCronJobsStoreCommit(storeKey);
    }
    throw error;
  }
}

function loadMutableCronStore(storePath: string): LoadedCronStore {
  const database = openOpenClawStateDatabase();
  const storeKey = cronStoreKey(path.resolve(storePath));
  return loadCronStoreFromDatabase(database.db, storeKey, {
    write: (operation, operationLabel) =>
      runOpenClawStateWriteTransaction(({ db }) => operation(db), { database }, { operationLabel }),
    committed: () => noteCronJobsStoreCommit(storeKey),
  });
}

export function assertCronJobsStoreUnchanged(
  db: DatabaseSync,
  storePath: string,
  expectedJobsFingerprint: string,
): undefined {
  const resolvedStorePath = path.resolve(storePath);
  if (readCronJobsFingerprint(db, cronStoreKey(resolvedStorePath)) !== expectedJobsFingerprint) {
    throw new CronJobsStoreChangedError(resolvedStorePath);
  }
}

/** Removes an owned declarative job family left under obsolete absolute store keys. */
export async function removeStaleCronJobFamilyRows(
  storePath: string,
  family: CronJobFamilyIdentity,
  opts?: { commitGuard?: () => void },
): Promise<number> {
  const storeKey = cronStoreKey(path.resolve(storePath));
  const context = captureOpenClawStateWorkerContext();
  let removed = 0;
  await runCronRuntimeMutation({
    context,
    type: "cron.removeStaleFamily",
    input: { storeKey, family: { ...family } },
    assertCurrent: () => opts?.commitGuard?.(),
    prepare: () => ({ value: {}, assertCurrent() {} }),
    publish: (outcome) => {
      removed = outcome.removed;
    },
  });
  return removed;
}

/** Loads only the persisted cron job store payload. */
export async function loadCronJobsStore(storePath: string): Promise<CronStoreFile> {
  return (await loadCronJobsStoreWithConfigJobs(storePath)).store;
}

/** Synchronously loads only the persisted cron job store payload. */
export function loadCronJobsStoreSync(storePath: string): CronStoreFile {
  return loadMutableCronStore(storePath).store;
}

type SaveCronStoreOptions = {
  stateOnly?: boolean;
};

type SaveCronJobsStoreOptions = CronStoreSaveOptions & {
  transactionHooks?: CronStoreTransactionHooks;
};

type CronStoreReplacementOptions = Pick<
  SaveCronJobsStoreOptions,
  "deleteQuarantineEntries" | "preserveRuntimeState" | "quarantine"
>;

type CronStoreCommit<Value> = { value: Value; revision: number };

function publishCronStoreSaveRevision(storeKey: string, observedRevision: number): number {
  const unchanged = getCronJobsStoreRevision(storeKey) === observedRevision;
  noteCronJobsStoreCommit(storeKey);
  // A host write across worker admission leaves the returned snapshot conservatively stale.
  return unchanged ? nextCronStoreRevision : STALE_CRON_STORE_REVISION;
}

function commitCronStoreNative<Value>(
  storeKey: string,
  operation: (database: OpenClawStateDatabase) => Value,
  hooks: CronStoreTransactionHooks | undefined,
  operationLabel?: string,
): CronStoreCommit<Value> {
  const observedRevision = getCronJobsStoreRevision(storeKey);
  let committed = false;
  try {
    const value = runOpenClawStateWriteTransaction(
      (database) => {
        const result = operation(database);
        deferSqlitePostCommitPublication(database.db, () => {
          committed = true;
        });
        return result;
      },
      {},
      operationLabel ? { operationLabel } : undefined,
    );
    hooks?.afterCommit?.();
    return { value, revision: publishCronStoreSaveRevision(storeKey, observedRevision) };
  } catch (error) {
    if (committed) {
      noteCronJobsStoreCommit(storeKey);
    }
    throw error;
  }
}

async function saveCronStoreWithWorker<Value>(
  storeKey: string,
  operation: (
    scope: Pick<SqliteWorkerStore<CronStoreSaveWorkerOperations>, "execute">,
  ) => Promise<CronStoreWriteResult<Value>>,
): Promise<CronStoreCommit<Value>> {
  const observedRevision = getCronJobsStoreRevision(storeKey);
  const context = captureOpenClawStateWorkerContext();
  let received = false;
  try {
    return await runOpenClawStateWorkerOperation(context, async (scope) => {
      const result = await operation(scope);
      received = true;
      const revision =
        result.committed || !result.ok
          ? publishCronStoreSaveRevision(storeKey, observedRevision)
          : observedRevision;
      if (!result.ok) {
        throw restoreCronSaveError(result.error);
      }
      return { value: result.value, revision };
    });
  } catch (error) {
    if (!received) {
      // A missing result cannot certify that no write committed. Never replay the mutation.
      noteCronJobsStoreCommit(storeKey);
    }
    throw error;
  }
}

/** Internal synchronous entry for callers whose authority callbacks must not yield before commit. */
export function saveCronJobsStoreChangesWithRevisionNative(
  storePath: string,
  previous: CronStoreFile,
  next: CronStoreFile,
  opts?: CronStoreChangesOptions & { transactionHooks?: CronStoreTransactionHooks },
): CronStoreCommit<CronStoreFile> {
  assertCronStoreCanPersist(next);
  const storeKey = cronStoreKey(path.resolve(storePath));
  const prepared = prepareCronStoreChanges(previous, next);
  if (prepared.changedIds.size === 0) {
    return { value: previous, revision: getCronJobsStoreRevision(storeKey) };
  }
  const { transactionHooks, ...options } = opts ?? {};
  return commitCronStoreNative(
    storeKey,
    ({ db }) =>
      saveCronStoreChangesInDatabase(db, storeKey, storeKey, prepared, options, transactionHooks),
    transactionHooks,
    "cron.config-mutation",
  );
}

/** Commits scheduler-disabled CRUD rows and retains this operation's revision fact. */
export async function saveCronJobsStoreChangesWithRevision(
  storePath: string,
  previous: CronStoreFile,
  next: CronStoreFile,
  opts?: CronStoreChangesOptions & { transactionHooks?: CronStoreTransactionHooks },
): Promise<CronStoreCommit<CronStoreFile>> {
  if (opts?.transactionHooks) {
    return saveCronJobsStoreChangesWithRevisionNative(storePath, previous, next, opts);
  }
  assertCronStoreCanPersist(next);
  const storeKey = cronStoreKey(path.resolve(storePath));
  const prepared = prepareCronStoreChanges(previous, next);
  if (prepared.changedIds.size === 0) {
    return { value: previous, revision: getCronJobsStoreRevision(storeKey) };
  }
  const { transactionHooks: _hooks, ...options } = opts ?? {};
  const input = structuredClone({ storeKey, changes: prepared, options });
  return await saveCronStoreWithWorker(storeKey, (scope) =>
    scope.execute({ type: "cron.saveChanges", input }),
  );
}

/** Commits only scheduler-disabled CRUD rows against authoritative SQLite state. */
export async function saveCronJobsStoreChanges(
  storePath: string,
  previous: CronStoreFile,
  next: CronStoreFile,
  opts?: CronStoreChangesOptions & { transactionHooks?: CronStoreTransactionHooks },
): Promise<CronStoreFile> {
  return (await saveCronJobsStoreChangesWithRevision(storePath, previous, next, opts)).value;
}

/** Internal synchronous entry preserving the caller's consumed guard/capture window. */
export function saveCronJobsStoreWithRevisionNative(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronJobsStoreOptions,
): CronStoreCommit<undefined> {
  const storeKey = cronStoreKey(path.resolve(storePath));
  if (!isCronRuntimeOnlySave(opts)) {
    assertCronStoreCanPersist(store);
  }
  const { transactionHooks, ...options } = opts ?? {};
  return commitCronStoreNative(
    storeKey,
    (database) => {
      saveCronStoreInDatabase(database, storeKey, store, options, transactionHooks);
      return undefined;
    },
    transactionHooks,
  );
}

/** Persist cron data and return only this operation's publication revision. */
export async function saveCronJobsStoreWithRevision(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronJobsStoreOptions,
): Promise<CronStoreCommit<undefined>> {
  if (opts?.transactionHooks) {
    return saveCronJobsStoreWithRevisionNative(storePath, store, opts);
  }
  const storeKey = cronStoreKey(path.resolve(storePath));
  if (!isCronRuntimeOnlySave(opts)) {
    assertCronStoreCanPersist(store);
  }
  const { transactionHooks: _hooks, ...options } = opts ?? {};
  const input = structuredClone({ storeKey, store, options });
  return await saveCronStoreWithWorker(storeKey, (scope) =>
    scope.execute({ type: "cron.save", input }),
  );
}

/** Persists cron jobs, or only mutable runtime state when stateOnly is set. */
export async function saveCronJobsStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronJobsStoreOptions,
): Promise<void> {
  await saveCronJobsStoreWithRevision(storePath, store, opts);
}

/** Atomically acquire doctor migration metadata and replace cron rows only for the winner. */
export async function saveCronJobsStoreWithMetadata(
  storePath: string,
  store: CronStoreFile,
  acquireMetadata: (db: DatabaseSync) => boolean,
  opts?: CronStoreReplacementOptions,
): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  assertCronStoreCanPersist(store);
  const committed = runOpenClawStateWriteTransaction((database) => {
    if (!acquireMetadata(database.db)) {
      return false;
    }
    if (opts?.quarantine?.entries.length) {
      saveCronQuarantinedJobs({
        storePath: resolvedStorePath,
        entries: opts.quarantine.entries,
        nowMs: opts.quarantine.nowMs,
        database,
      });
    }
    if (opts?.deleteQuarantineEntries?.length) {
      deleteCronQuarantinedJobsFromDatabase({
        database: database.db,
        storePath: resolvedStorePath,
        entries: opts.deleteQuarantineEntries,
      });
    }
    replaceCronStoreRowsInDatabase(
      database.db,
      storeKey,
      store,
      opts?.preserveRuntimeState === true,
    );
    return true;
  });
  if (committed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return committed;
}

// Public plugin SDK seam; core callers use the SQLite-backed cron-jobs names above.
/** Resolves the public plugin-SDK cron store path. */
export function resolveCronStorePath(storePath?: string) {
  return resolveCronJobsStorePath(storePath);
}

/** Plugin-SDK alias for loading the cron store. */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return await loadCronJobsStore(storePath);
}

/** Plugin-SDK alias for saving the cron store. */
export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  await saveCronJobsStore(storePath, store, opts);
}
