import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  enableNodeSqliteKyselyStatementCache,
  executeWithCachedStatement,
} from "../infra/kysely-sync-cache-state.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

type Observer = ReturnType<typeof openOpenClawStateReadOnlyLocation>;
const observers = new Map<string, Observer>();

function authorityObserver(admission: OpenClawStateDatabaseReadAdmission): Observer | undefined {
  admission.assertCurrent();
  const key = admission.identity.key;
  const existing = observers.get(key);
  if (existing) {
    observeOpenClawDatabaseMaintenanceResource(existing);
    return existing;
  }
  if (!existingPathOrUndefined(admission.databasePath)) {
    return undefined;
  }
  // This independent reader never borrows a writer's pinned transaction.
  const observer = openOpenClawStateReadOnlyLocation(
    admission.databasePath,
    admission.databasePath,
  );
  enableNodeSqliteKyselyStatementCache(observer.database.db);
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    observer.close();
    closed = true;
    if (observers.get(key) === observer) {
      observers.delete(key);
    }
    unregister();
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (!identity || identity.key === key) {
        close();
      }
    },
  });
  getOpenClawDatabaseMaintenanceScope()?.own(observer, "shared-resources", close);
  observers.set(key, observer);
  return observer;
}

/** SQLite owns foreign-commit freshness; local fences still own unsettled mutations. */
export function captureUserProfileAuthorityFreshness<T>(
  admission: OpenClawStateDatabaseReadAdmission,
  select: (db: DatabaseSync) => T,
) {
  const observer = authorityObserver(admission);
  if (!observer) {
    return { isCurrent: () => false, matches: () => false };
  }
  const db = observer.database.db;
  const readVersion = () =>
    executeWithCachedStatement(db, "PRAGMA data_version", [], (statement) => statement.get())
      ?.data_version;
  // Capture before selecting: a commit during the selection must trigger another read.
  let version = readVersion();
  const expected = select(db);
  let current = true;
  const isCurrent = () => {
    if (!current) {
      return false;
    }
    try {
      admission.assertCurrent();
      if (observers.get(admission.identity.key) !== observer || !db.isOpen) {
        return (current = false);
      }
      const nextVersion = readVersion();
      if (nextVersion !== version) {
        assertStateReadSchema(db, admission.databasePath);
        current = isDeepStrictEqual(expected, select(db));
        version = nextVersion;
      }
      return current;
    } catch {
      return (current = false);
    }
  };
  return {
    isCurrent,
    matches: (matches: (facts: T) => boolean) => isCurrent() && matches(expected),
  };
}
