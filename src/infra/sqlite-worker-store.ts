import { isMainThread } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerStoreOptions } from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

export {
  SqliteWorkerError,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";

/** Retain one actor through local reconciliation; the callback must not await its own close. */
export function runSqliteWorkerStoreOperation<Operations extends SqliteWorkerOperations, T>(
  store: SqliteWorkerStore<Operations>,
  operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
  stateContext?: SqliteWorkerStateContext,
  assertCurrent?: (commandType: PropertyKey) => void,
): Promise<T> {
  return resolveSqliteWorkerBroker().runOperation(store, operation, stateContext, assertCurrent);
}

function resolveSqliteWorkerBroker() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteWorkerBroker"),
    () => new SqliteWorkerBroker(),
    (broker) => broker.close(),
  );
}

/** Read the broker's recorded lifecycle state without probing native storage. */
export function isSqliteWorkerStoreAvailable(store: object): boolean {
  return resolveSqliteWorkerBroker().isAvailable(store);
}

/** Recorded orphan custody at its original shared-state opening path. */
export function hasUnclaimedSharedStateSqliteCleanup(databasePath: string): boolean {
  return resolveSqliteWorkerBroker().hasUnclaimedSharedStateCleanup(databasePath);
}

/** Explicit cleanup only; referenced actors and other opening scopes are untouched. */
export function closeUnclaimedSharedStateSqliteWorkers(databasePath: string): Promise<void> {
  return resolveSqliteWorkerBroker().closeUnclaimedSharedState(databasePath);
}

export function openSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions & { existingOnly: true },
): Promise<SqliteWorkerStore<Operations> | undefined>;
export function openSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions & { existingOnly?: false },
): Promise<SqliteWorkerStore<Operations>>;
export function openSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions,
): Promise<SqliteWorkerStore<Operations> | undefined>;
export function openSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions,
): Promise<SqliteWorkerStore<Operations> | undefined> {
  if (!isMainThread) {
    return Promise.reject(
      new SqliteWorkerError(
        "SQLite stores in application workers require the host broker connection",
        "unavailable",
      ),
    );
  }
  return resolveSqliteWorkerBroker().open<Operations>(options);
}

/** Host-internal admission for the canonical shared-state actor. */
export function openSharedStateSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: Omit<SqliteWorkerStoreOptions, "input">,
  stateContext: SqliteWorkerStateContext,
  assertCurrent?: () => void,
): Promise<SqliteWorkerStore<Operations> | undefined> {
  if (!isMainThread) {
    return Promise.reject(
      new SqliteWorkerError("Shared-state admission requires the host broker", "unavailable"),
    );
  }
  return resolveSqliteWorkerBroker().open<Operations>(
    { ...options, input: undefined },
    stateContext,
    assertCurrent,
  );
}
