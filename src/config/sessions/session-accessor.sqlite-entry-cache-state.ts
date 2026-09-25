import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionEntryCacheDatabase } from "./session-accessor.sqlite-entry-cache-projection.js";
import type {
  CommittedSessionSharingFacts,
  SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.types.js";
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

// Process-held stores cannot be reopened in a worker. Their existing writer publishes
// only sharing fields, bounded by live entries and the native database's lifetime.
const incognitoSharingEntries = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionSharingEntries"),
  () =>
    new WeakMap<
      DatabaseSync,
      {
        entries: Map<string, CommittedSessionSharingFacts | null>;
        pending: Map<string, Set<object>>;
      }
    >(),
);

export function incognitoSharingState(database: DatabaseSync) {
  let state = incognitoSharingEntries.get(database);
  if (!state) {
    state = { entries: new Map(), pending: new Map() };
    incognitoSharingEntries.set(database, state);
  }
  return state;
}

export function stageIncognitoSharingPublication(database: DatabaseSync, sessionKey: string) {
  const state = incognitoSharingState(database);
  const token = {};
  const pending = state.pending.get(sessionKey) ?? new Set<object>();
  state.pending.set(sessionKey, pending);
  pending.add(token);
  return () => {
    pending.delete(token);
    if (pending.size === 0) {
      state.pending.delete(sessionKey);
    }
  };
}

export function readCommittedIncognitoSessionSharing(database: DatabaseSync, sessionKey: string) {
  const state = incognitoSharingEntries.get(database);
  if (state?.pending.has(sessionKey)) {
    throw new Error("Incognito session sharing publication is pending");
  }
  const current = state?.entries.get(sessionKey);
  if (current === null) {
    throw new Error("Incognito session sharing projection is unavailable");
  }
  return current;
}
