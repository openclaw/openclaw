import { getPostgresPhysicalFacts } from "../../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { readSqliteDatabaseSiblingWriteRevision } from "../../infra/sqlite-database-admission.js";
import {
  getAdmittedSqliteSchemaFacts,
  readSqliteNativeMutationRevision,
} from "../../infra/sqlite-schema-facts.js";

/** Connection revision shared by entry snapshots and maintenance age facts. */
export type SqliteSessionEntryRevision = {
  siblingWriteRevision: number | undefined;
  sessionNodesGeneration: number | undefined;
  schemaVersion: number;
};

export function readSessionNodesGeneration(database: EngineConnection): number {
  const revision = readSqliteNativeMutationRevision(database);
  if (revision === undefined) {
    throw new Error("SQLite session entry caching requires a tracked writer");
  }
  // The writer records mutations and rollback; known writes publish their cache receipts.
  // Uncovered writes expire metadata without another table-specific tracker.
  return revision;
}

export function readSessionEntryCacheValidityToken(
  database: EngineConnection,
): SqliteSessionEntryRevision {
  if (isPostgresSqlConnection(database)) {
    const schema = getPostgresPhysicalFacts(database);
    if (!schema) {
      throw new Error("Session entry caching requires admitted PostgreSQL schema facts");
    }
    // PG lacks scoped cache coverage; never certify reuse with native row-cache receipts.
    return {
      siblingWriteRevision: undefined,
      sessionNodesGeneration: undefined,
      schemaVersion: schema.version,
    };
  }
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("SQLite session entry caching requires admitted schema facts");
  }
  // Shared settlement receipts cover other handles; the local receipt covers pending writes.
  return {
    siblingWriteRevision: readSqliteDatabaseSiblingWriteRevision(database),
    sessionNodesGeneration: readSessionNodesGeneration(database),
    schemaVersion: schema.schemaVersion,
  };
}

export function cacheValidityTokensEqual(
  left: SqliteSessionEntryRevision,
  right: SqliteSessionEntryRevision,
): boolean {
  return (
    left.siblingWriteRevision !== undefined &&
    left.siblingWriteRevision === right.siblingWriteRevision &&
    left.sessionNodesGeneration === right.sessionNodesGeneration &&
    left.schemaVersion === right.schemaVersion
  );
}

class SessionEntryRevisionConflictError extends Error {
  readonly code = "invalid_state";
}

/** Reuse prepared facts until this connection observes a write, then compare only their predicate. */
export function createSessionEntryRevisionGuard(
  database: EngineConnection,
  assertSourceCurrent: () => void,
  matches: () => boolean,
): () => void {
  let verified: SqliteSessionEntryRevision | undefined;
  return () => {
    assertSourceCurrent();
    const revision = readSessionEntryCacheValidityToken(database);
    if (verified && !database.isTransaction && cacheValidityTokensEqual(verified, revision)) {
      assertSourceCurrent();
      return;
    }
    verified = undefined;
    if (!matches()) {
      throw new SessionEntryRevisionConflictError(
        "Prepared session entry facts are no longer current",
      );
    }
    assertSourceCurrent();
    // A concurrent receipt invalidates this pre-read token on the next check.
    // Transactional predicates are checked at each effect, not cached past settlement.
    if (!database.isTransaction) {
      verified = revision;
    }
  };
}
