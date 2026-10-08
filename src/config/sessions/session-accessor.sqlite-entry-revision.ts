import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  getAdmittedSqliteSchemaFacts,
  getSqliteReadScopeRevision,
  installSqliteTempTrackingSchema,
  readSqliteCacheDataVersion,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";

/** Connection revision shared by entry snapshots and maintenance age facts. */
export type SqliteSessionEntryRevision = {
  dataVersion: number;
  sessionNodesGeneration: number;
};

const sessionNodesGenerationTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();
const sessionNodesGenerationFacts = new WeakMap<
  DatabaseSync,
  { revision: SqliteReadScopeRevision; generation: number }
>();

type SessionEntryRevisionDatabase = {
  openclaw_session_nodes_cache_generation: { id: number; generation: unknown };
};

const generationQuery = createSqliteQueryCache((database) =>
  prepareSqliteQueryTakeFirstSync<void, { generation: unknown }>(database, () =>
    getNodeSqliteKysely<SessionEntryRevisionDatabase>(database)
      .withSchema("temp")
      .selectFrom("openclaw_session_nodes_cache_generation")
      .select("generation")
      .where("id", "=", 1),
  ),
);

function ensureSessionNodesGenerationTracker(database: DatabaseSync): void {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("SQLite session entry caching requires admitted schema facts");
  }
  const { schemaVersion } = schema;
  const trackedSchemaVersion = sessionNodesGenerationTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaVersion) {
    return;
  }
  const hasParticipants = schema.tables.has("session_participants");
  // A main-schema change advances the counter before reinstalling its raw-DML observers.
  installSqliteTempTrackingSchema(database, {
    kind: "generation",
    table: "openclaw_session_nodes_cache_generation",
    triggers: ["session_nodes", "session_participants"].flatMap((table) =>
      (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => ({
        name: `openclaw_${table}_cache_generation_${operation.toLowerCase()}`,
        table,
        operation,
        enabled: table === "session_nodes" || hasParticipants,
      })),
    ),
    advance: trackedSchemaVersion !== undefined,
  });
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    sessionNodesGenerationTrackerSchemaVersions.set(database, schemaVersion);
  } else {
    stageSqliteTransactionState(database, {
      stage: () => sessionNodesGenerationTrackerSchemaVersions.set(database, schemaVersion),
      rollback: () => sessionNodesGenerationTrackerSchemaVersions.delete(database),
      commit: () => {},
    });
  }
}

export function readSessionNodesGeneration(database: DatabaseSync): number {
  ensureSessionNodesGenerationTracker(database);
  const revision = getSqliteReadScopeRevision(database);
  const retained = sessionNodesGenerationFacts.get(database);
  if (revision && retained?.revision === revision) {
    return retained.generation;
  }
  const row = generationQuery(database)();
  if (typeof row?.generation !== "number") {
    throw new Error("SQLite session_nodes cache generation is unavailable");
  }
  if (revision && getSqliteReadScopeRevision(database) === revision) {
    sessionNodesGenerationFacts.set(database, { revision, generation: row.generation });
  } else {
    sessionNodesGenerationFacts.delete(database);
  }
  return row.generation;
}

export function readSessionEntryCacheValidityToken(
  database: DatabaseSync,
  mode: "fresh" | "cached" = "fresh",
): SqliteSessionEntryRevision {
  return {
    dataVersion: readSqliteCacheDataVersion(database, mode),
    sessionNodesGeneration: readSessionNodesGeneration(database),
  };
}

export function cacheValidityTokensEqual(
  left: SqliteSessionEntryRevision,
  right: SqliteSessionEntryRevision,
): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.sessionNodesGeneration === right.sessionNodesGeneration
  );
}

class SessionEntryRevisionConflictError extends Error {
  readonly code = "invalid_state";
}

class SessionEntryRevisionChangedError extends SessionEntryRevisionConflictError {}

/** Reuse prepared facts until this connection observes a write, then compare only their predicate. */
export function createSessionEntryRevisionGuard(
  database: DatabaseSync,
  assertSourceCurrent: () => void,
  matches: () => boolean,
  mode: "mutation" | "read" = "mutation",
): () => void {
  let verified: SqliteSessionEntryRevision | undefined;
  const guard = () => {
    assertSourceCurrent();
    const before = readSessionEntryCacheValidityToken(database);
    if (verified && cacheValidityTokensEqual(verified, before)) {
      assertSourceCurrent();
      return;
    }
    verified = undefined;
    if (!matches()) {
      throw new SessionEntryRevisionConflictError(
        "Prepared session entry facts are no longer current",
      );
    }
    const after = readSessionEntryCacheValidityToken(database);
    assertSourceCurrent();
    // A foreign commit during the predicate must not be hidden by its later revision.
    if (!cacheValidityTokensEqual(before, after)) {
      throw new SessionEntryRevisionChangedError(
        "Session entry facts changed during their mutation check",
      );
    }
    if (!database.isTransaction) {
      verified = after;
    } else {
      // A first-use TEMP tracker can disappear on rollback and later restart at the same value.
      // Unmanaged transactions cannot retain a verified snapshot past their unknown settlement.
      stageSqliteTransactionState(database, {
        stage: () => {
          verified = after;
        },
        rollback: () => {
          verified = undefined;
        },
        commit: () => {},
      });
    }
  };
  if (mode === "mutation") {
    return guard;
  }
  return () => {
    try {
      guard();
    } catch (error) {
      if (!(error instanceof SessionEntryRevisionChangedError) || database.isTransaction) {
        throw error;
      }
      // Reprepare read facts once; no snapshot outlives this check.
      runSqlitePinnedReadSnapshotSync(database, guard);
    }
  };
}
