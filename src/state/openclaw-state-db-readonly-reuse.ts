import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { SqliteCoordinatorError } from "../infra/sqlite-lifecycle-errors.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { isManagedStateTransaction } from "./openclaw-state-db-transaction.js";
import { allowsMaintenanceLiveAuthorityReads } from "./openclaw-state-maintenance-context.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

export type ReusedOpenClawStateReadOnlyDatabase<T> = { reused: false } | { reused: true; value: T };

const maintenanceReaders = new WeakMap<
  OpenClawDatabaseMaintenanceScope,
  Map<string, { read: <T>(operation: (db: OpenClawStateReadOnlyDatabase) => T) => T }>
>();

/** Mutable maintenance owns this live reader until drainage; each guard queries current rows. */
export function withMaintenanceOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (!scope || !allowsMaintenanceLiveAuthorityReads(scope, pathname)) {
    return { reused: false };
  }
  scope.assertReadAdmission();
  let readers = maintenanceReaders.get(scope);
  if (!readers) {
    readers = new Map();
    maintenanceReaders.set(scope, readers);
  }
  let reader = readers.get(pathname);
  if (!reader) {
    const admission = captureOpenClawStateDatabaseReadAdmission(pathname);
    assertExistingDatabaseIdentity(pathname, admission.identity.key, admission.identity.birthtime);
    const connection = openOpenClawStateReadOnlyLocation(pathname, pathname);
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      if (!connection.close()) {
        throw new Error("Maintenance authority reader cleanup is incomplete");
      }
      closed = true;
      readers.delete(pathname);
      unregister();
    };
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        if (
          !identity ||
          identity.key === admission.identity.key ||
          identity.canonicalPath === admission.identity.canonicalPath
        ) {
          close();
        }
      },
    });
    scope.own(connection, "shared-handles", close);
    reader = {
      read(readOperation) {
        admission.assertCurrent();
        assertExistingDatabaseIdentity(
          pathname,
          admission.identity.key,
          admission.identity.birthtime,
        );
        const value = runSqliteReadOperationSync(connection.database.db, () => {
          assertStateReadSchema(connection.database.db, pathname);
          return readOperation(connection.database);
        });
        if (isPromiseLike(value)) {
          throw new SqliteCoordinatorError(
            "SQLite maintenance authority read must remain synchronous",
          );
        }
        return value;
      },
    };
    readers.set(pathname, reader);
  }
  return { reused: true, value: reader.read(operation) };
}

/** Current-authority guards can borrow their writer; discovery sees committed rows. */
export function withCachedOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  currentAuthority: boolean,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  return (
    openClawStateDatabaseCache.withCachedOpenClawStateDatabase(
      pathname,
      { readOnly: true },
      (opened): ReusedOpenClawStateReadOnlyDatabase<T> => {
        if (!opened.db.isOpen) {
          return { reused: false };
        }
        const ownedTransaction = currentAuthority && isManagedStateTransaction(opened.db);
        if (opened.db.isTransaction && !ownedTransaction) {
          return { reused: false };
        }
        try {
          // Cache admission and the consuming read share this operation's fresh revision.
          if (isExistingOpenClawStateSchema(pathname, opened.db)) {
            assertStateReadSchema(opened.db, pathname);
          }
          observeOpenClawDatabaseMaintenanceResource(opened.db);
          const value = operation(opened);
          if (ownedTransaction && isPromiseLike(value)) {
            throw new SqliteCoordinatorError(
              "SQLite current-authority read must remain synchronous",
            );
          }
          return { reused: true, value };
        } catch (error) {
          openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(opened, error);
          throw error;
        }
      },
    ) ?? { reused: false }
  );
}

/** A native read borrow can avoid copying only while its original physical path still matches. */
export function canReadWarmNativeSourceIndependently(
  database: OpenClawStateDatabase,
  pathname: string,
  admittedIdentity: string,
): boolean {
  const identity = requireOpenClawStateDatabaseIdentity(database);
  if (identity.key !== admittedIdentity) {
    return false;
  }
  try {
    assertExistingDatabaseIdentity(pathname, identity.key);
    return true;
  } catch {
    // An unavailable or replaced path keeps the original native snapshot source.
    return false;
  }
}
