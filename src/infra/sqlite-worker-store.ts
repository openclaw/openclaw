import { isMainThread } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerStoreOptions } from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";

export {
  SqliteWorkerError,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";

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
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteWorkerBroker"),
    () => new SqliteWorkerBroker(),
    (broker) => broker.close(),
  ).open<Operations>(options);
}
