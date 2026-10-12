import type { DatabaseSync } from "node:sqlite";
import { readSqliteDatabaseSiblingWriteRevision } from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  getAdmittedSqliteSchemaFacts,
  installSqliteTempTrackingSchema,
  readSqliteRollbackRevision,
} from "../../infra/sqlite-schema-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/** Connection revision shared by entry snapshots and maintenance age facts. */
export type SqliteSessionEntryRevision = {
  siblingWriteRevision: number | undefined;
  sessionNodesGeneration: number;
};

type SessionNodesGeneration = {
  schemaVersion?: number;
  generation: number;
  rollbackRevision: number | undefined;
};
const sessionNodesGenerations = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionNodesGenerations"),
  () => new WeakMap<DatabaseSync, SessionNodesGeneration>(),
);
const generationFunction = "openclaw_session_nodes_changed";

function ensureSessionNodesGenerationTracker(database: DatabaseSync): SessionNodesGeneration {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("SQLite session entry caching requires admitted schema facts");
  }
  const { schemaVersion } = schema;
  let tracker = sessionNodesGenerations.get(database);
  if (!tracker) {
    const created: SessionNodesGeneration = {
      generation: 0,
      rollbackRevision: readSqliteRollbackRevision(database),
    };
    database.function(generationFunction, () => {
      created.generation += 1;
      return null;
    });
    sessionNodesGenerations.set(database, created);
    tracker = created;
  }
  if (tracker.schemaVersion === schemaVersion) {
    return tracker;
  }
  const hasParticipants = schema.tables.has("session_participants");
  if (tracker.schemaVersion !== undefined) {
    tracker.generation += 1;
  }
  installSqliteTempTrackingSchema(database, {
    kind: "generation",
    functionName: generationFunction,
    triggers: ["session_nodes", "session_participants"].flatMap((table) =>
      (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => ({
        name: `openclaw_${table}_cache_generation_${operation.toLowerCase()}`,
        table,
        operation,
        enabled: table === "session_nodes" || hasParticipants,
      })),
    ),
  });
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    tracker.schemaVersion = schemaVersion;
  } else {
    const installed = tracker;
    stageSqliteTransactionState(database, {
      stage: () => {
        installed.schemaVersion = schemaVersion;
      },
      rollback: () => {
        installed.schemaVersion = undefined;
      },
      commit: () => {},
    });
  }
  return tracker;
}

export function readSessionNodesGeneration(database: DatabaseSync): number {
  const tracker = ensureSessionNodesGenerationTracker(database);
  const rollbackRevision = readSqliteRollbackRevision(database);
  // JS callbacks are not rolled back by SQLite. Advance again so an abandoned
  // snapshot can never reuse the token observed after its uncommitted writes.
  if (rollbackRevision === undefined || rollbackRevision !== tracker.rollbackRevision) {
    tracker.generation += 1;
    tracker.rollbackRevision = rollbackRevision;
  }
  return tracker.generation;
}

export function readSessionEntryCacheValidityToken(
  database: DatabaseSync,
): SqliteSessionEntryRevision {
  // Shared writer receipts cover other handles; TEMP triggers cover this connection's writes.
  return {
    siblingWriteRevision: readSqliteDatabaseSiblingWriteRevision(database),
    sessionNodesGeneration: readSessionNodesGeneration(database),
  };
}

export function cacheValidityTokensEqual(
  left: SqliteSessionEntryRevision,
  right: SqliteSessionEntryRevision,
): boolean {
  return (
    left.siblingWriteRevision !== undefined &&
    left.siblingWriteRevision === right.siblingWriteRevision &&
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
