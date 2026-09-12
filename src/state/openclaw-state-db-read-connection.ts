import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";

export type OpenClawStateReadConnection = {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  close: () => boolean;
};

class SnapshotCleanupIncompleteError extends Error {}

/** Own one native reader; callers retain their runtime or maintenance schema policy. */
export function openOpenClawStateReadConnection(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
): OpenClawStateReadConnection {
  const snapshot = typeof source === "string" ? undefined : source;
  const location = typeof source === "string" ? source : source.location;
  // The first catalog read needs the busy handler; installing a later PRAGMA is too late.
  const options = { readOnly: true, timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
  let db: OpenClawStateDatabase["db"];
  try {
    db =
      location === pathname
        ? openTrackedStateDatabase(pathname, options)
        : openNodeSqliteDatabase(location, options);
  } catch (error) {
    snapshot?.cleanup();
    throw error;
  }
  let closed = false;
  const database = {
    db,
    path: pathname,
    afterClose: (): undefined => {
      if (snapshot && !snapshot.cleanup()) {
        throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
      }
      closed = true;
      return undefined;
    },
  };
  return {
    database: { db, path: pathname },
    close() {
      if (closed) {
        return false;
      }
      // A failed close remains owned for retry, including private snapshot handles.
      const errors = openClawStateDatabaseCache.closeOpenClawStateDatabaseHandle(database);
      if (errors.length === 1 && errors[0] instanceof SnapshotCleanupIncompleteError) {
        return false;
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Shared-state reader cleanup failed.",
          errors[0],
        );
      }
      return true;
    },
  };
}
