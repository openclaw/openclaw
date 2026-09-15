import { isMainThread } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hydrateOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type {
  PreparedSqliteWorkerOpen,
  SqliteWorkerStoreOptions,
} from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

function withCallerErrors<T>(result: Promise<T>): Promise<T> {
  return result.catch((error: unknown) => {
    if (error instanceof Error) {
      throw hydrateOpenClawStateWorkerError(error);
    }
    throw error;
  });
}

function bindCallerExecute<Operations extends SqliteWorkerOperations>(
  scope: Pick<SqliteWorkerStore<Operations>, "execute">,
): Pick<SqliteWorkerStore<Operations>, "execute"> {
  return {
    execute: (command, options) => {
      const result = withCallerErrors(scope.execute(command, options));
      // The broker also observes abandoned command rejections while draining them.
      void result.catch(() => undefined);
      return result;
    },
  };
}

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
  return withCallerErrors(
    resolveSqliteWorkerBroker().runOperation(
      store,
      (scope) => operation(bindCallerExecute(scope)),
      stateContext,
      assertCurrent,
    ),
  );
}

function resolveSqliteWorkerBroker() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteWorkerBroker"),
    () => new SqliteWorkerBroker(),
    (broker) => withCallerErrors(broker.close()),
  );
}

/** Separate admission + worker pool for foreign/plugin DBs (e.g. iMessage chat.db). */
function resolveIsolatedSqliteWorkerBroker() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteWorkerBroker.isolated"),
    () => new SqliteWorkerBroker(),
    (broker) => withCallerErrors(broker.close()),
  );
}

/** Read the broker's recorded lifecycle state without probing native storage. */
export function isSqliteWorkerStoreAvailable(store: object): boolean {
  return (
    resolveSqliteWorkerBroker().isAvailable(store) ||
    resolveIsolatedSqliteWorkerBroker().isAvailable(store)
  );
}

/** Recorded orphan custody at its original shared-state opening path. */
export function hasUnclaimedSharedStateSqliteCleanup(databasePath: string): boolean {
  return resolveSqliteWorkerBroker().hasUnclaimedSharedStateCleanup(databasePath);
}

/** Explicit cleanup only; referenced actors and other opening scopes are untouched. */
export function closeUnclaimedSharedStateSqliteWorkers(databasePath: string): Promise<void> {
  return withCallerErrors(resolveSqliteWorkerBroker().closeUnclaimedSharedState(databasePath));
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

/**
 * Open a foreign/plugin database on an isolated broker admission lane.
 *
 * Use for existing-only reads against paths outside OpenClaw state (e.g. macOS
 * Messages chat.db). A wedged native open then pins only this lane's worker pool
 * and admissionTail — shared OpenClaw SQLite admission stays responsive (#148750).
 */
export function openIsolatedSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions & { existingOnly: true },
): Promise<SqliteWorkerStore<Operations> | undefined>;
export function openIsolatedSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions & { existingOnly?: false },
): Promise<SqliteWorkerStore<Operations>>;
export function openIsolatedSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: SqliteWorkerStoreOptions,
): Promise<SqliteWorkerStore<Operations> | undefined>;
export function openIsolatedSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
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
  return resolveIsolatedSqliteWorkerBroker().open<Operations>(options);
}

/** Host-internal admission for the canonical shared-state actor. */
export function openSharedStateSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  options: Omit<SqliteWorkerStoreOptions, "input">,
  stateContext: SqliteWorkerStateContext,
  assertCurrent?: () => void,
  lifecycle?: Pick<PreparedSqliteWorkerOpen, "maintenanceScope" | "retainCleanup">,
): Promise<SqliteWorkerStore<Operations> | undefined> {
  if (!isMainThread) {
    return Promise.reject(
      new SqliteWorkerError("Shared-state admission requires the host broker", "unavailable"),
    );
  }
  return withCallerErrors(
    resolveSqliteWorkerBroker().open<Operations>(
      { ...options, input: undefined },
      stateContext,
      assertCurrent,
      lifecycle,
    ),
  ).then((store) => {
    if (store) {
      const execute = store.execute.bind(store);
      const close = store.close.bind(store);
      // Keep the broker's binding identity while owning errors at this API boundary.
      store.execute = bindCallerExecute<Operations>({ execute }).execute;
      store.close = () => withCallerErrors(close());
    }
    return store;
  });
}
