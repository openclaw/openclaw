import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  getAdmittedSqliteSchemaFacts,
  readSqliteCacheDataVersion,
} from "../../infra/sqlite-schema-facts.js";

/** Connection revision shared by entry snapshots and maintenance age facts. */
export type SqliteSessionEntryRevision = {
  dataVersion: number;
  sessionNodesGeneration: number;
};

const sessionNodesGenerationTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

type SessionEntryRevisionDatabase = {
  openclaw_session_nodes_cache_generation: { id: number; generation: unknown };
};

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
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary: they
  // observe unpublished raw DML. A main-schema change bumps the generation before reinstalling
  // them, so dropping/recreating session_nodes cannot make an old snapshot look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_nodes_cache_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_nodes_cache_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_delete;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_delete
      AFTER DELETE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_delete;
    ${
      hasParticipants
        ? `
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_insert
      AFTER INSERT ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_update
      AFTER UPDATE ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_delete
      AFTER DELETE ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    `
        : ""
    }
  `);
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    sessionNodesGenerationTrackerSchemaVersions.set(database, schemaVersion);
  } else {
    const version = schemaVersion;
    stageSqliteTransactionState(database, {
      stage: () => sessionNodesGenerationTrackerSchemaVersions.set(database, version),
      rollback: () => sessionNodesGenerationTrackerSchemaVersions.delete(database),
      commit: () => {},
    });
  }
}

export function readSessionNodesGeneration(database: DatabaseSync): number {
  ensureSessionNodesGenerationTracker(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<SessionEntryRevisionDatabase>(database)
      .withSchema("temp")
      .selectFrom("openclaw_session_nodes_cache_generation")
      .select("generation")
      .where("id", "=", 1),
  );
  if (typeof row?.generation !== "number") {
    throw new Error("SQLite session_nodes cache generation is unavailable");
  }
  return row.generation;
}

export function readSessionEntryCacheValidityToken(
  database: DatabaseSync,
  mode: "fresh" | "cached" = "fresh",
): SqliteSessionEntryRevision {
  return {
    dataVersion:
      mode === "cached" ? readSqliteCacheDataVersion(database) : readSqliteDataVersion(database),
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

/** Reuse prepared facts until this connection observes a write, then compare only their predicate. */
export function createSessionEntryRevisionGuard(
  database: DatabaseSync,
  assertSourceCurrent: () => void,
  matches: () => boolean,
): () => void {
  let verified: SqliteSessionEntryRevision | undefined;
  return () => {
    assertSourceCurrent();
    const before = readSessionEntryCacheValidityToken(database);
    if (verified && cacheValidityTokensEqual(verified, before)) {
      assertSourceCurrent();
      return;
    }
    if (!matches()) {
      throw new SessionEntryRevisionConflictError(
        "Prepared session entry facts are no longer current",
      );
    }
    const after = readSessionEntryCacheValidityToken(database);
    assertSourceCurrent();
    // A foreign commit during the predicate must not be hidden by its later revision.
    if (!cacheValidityTokensEqual(before, after)) {
      throw new SessionEntryRevisionConflictError(
        "Session entry facts changed during their mutation check",
      );
    }
    verified = after;
  };
}
