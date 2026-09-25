import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { SessionEntryCacheDatabase } from "./session-accessor.sqlite-entry-cache-projection.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteSessionEntryRevision } from "./session-accessor.sqlite-entry-revision.js";

export type SqliteSessionEntryCache = SessionEntryCacheSnapshot & {
  validityToken: SqliteSessionEntryRevision;
};

// Retain listing metadata only; complete prompt snapshots belong to the caller's full read.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
export const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();

export function publishTrackedCacheUpdate(
  database: SessionEntryCacheDatabase,
  publish: () => void,
  stage?: () => () => void,
): boolean {
  let settle: (() => void) | undefined;
  // Committed cache state must settle before observers can reenter with newer writes.
  if (
    stageSqliteTransactionState(database.db, {
      stage: () => {
        settle = stage?.();
      },
      rollback: () => settle?.(),
      commit: () => {
        try {
          publish();
        } finally {
          settle?.();
        }
      },
    })
  ) {
    return true;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
  return false;
}
