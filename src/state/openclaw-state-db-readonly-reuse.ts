import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { assertStateReadSchema } from "./openclaw-state-db-read-connection.js";
import { isCoordinatedStateTransaction } from "./openclaw-state-db-write-coordination.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

export type ReusedOpenClawStateReadOnlyDatabase<T> = { reused: false } | { reused: true; value: T };

/** Current-authority guards can borrow their writer; discovery sees committed rows. */
export function withCachedOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  currentAuthority: boolean,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const opened = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname, {
    readOnly: true,
  });
  if (!opened?.db.isOpen) {
    return { reused: false };
  }
  const ownedTransaction = currentAuthority && isCoordinatedStateTransaction(opened.db);
  if (opened.db.isTransaction && !ownedTransaction) {
    return { reused: false };
  }
  try {
    // Terminal failures evict this handle. Retain schema admission even while
    // borrowing a writer; another build can migrate an idle cached database.
    assertStateReadSchema(opened.db, pathname);
    observeOpenClawDatabaseMaintenanceResource(opened.db);
    const value = operation(opened);
    if (ownedTransaction && isPromiseLike(value)) {
      throw new SqliteCoordinatorError("SQLite current-authority read must remain synchronous");
    }
    return { reused: true, value };
  } catch (error) {
    openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(opened, error);
    throw error;
  }
}
