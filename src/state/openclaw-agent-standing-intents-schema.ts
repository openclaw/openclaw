import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const STANDING_INTENTS_TABLE = "standing_intents";
export const STANDING_INTENTS_FTS_TABLE = "standing_intents_fts";
export const STANDING_INTENTS_FTS_SHADOW_TABLES = [
  "standing_intents_fts_config",
  "standing_intents_fts_data",
  "standing_intents_fts_docsize",
  "standing_intents_fts_idx",
] as const;

const admittedSchemas = new WeakMap<DatabaseSync, SqliteSchemaFacts>();

function hasCurrentStandingIntentsSchema(db: DatabaseSync): boolean {
  const cached = admittedSchemas.get(db);
  if (!cached) {
    return false;
  }
  try {
    if (getAdmittedSqliteSchemaFacts(db) === cached) {
      return true;
    }
  } catch {
    // Cache observation cannot replace the schema owner's original SQL outcome.
  }
  admittedSchemas.delete(db);
  return false;
}

function rememberCommittedStandingIntentsSchema(db: DatabaseSync, schemaSql: string): void {
  admittedSchemas.delete(db);
  try {
    if (!db.isOpen || db.isTransaction) {
      return;
    }
    const before = getAdmittedSqliteSchemaFacts(db);
    if (!before || collectSqliteSchemaIssues(db, schemaSql).length > 0) {
      return;
    }
    // Validation owns its pinned snapshot; cache only the unchanged admitted owner outside it.
    const after = getAdmittedSqliteSchemaFacts(db);
    if (after === before) {
      admittedSchemas.set(db, after);
    }
  } catch {
    // Post-commit observers must not turn a completed schema transaction into a failure.
  }
}

type StandingIntentColumnInfo = { name?: unknown };

function ensureStandingIntentCreatorColumn(db: DatabaseSync): void {
  const columns = /* sqlite-allow-raw -- Canonical additive schema inspection only. */ db
    .prepare("PRAGMA table_info(standing_intents)")
    .all() as StandingIntentColumnInfo[];
  if (columns.some((column) => column.name === "creator_sender")) {
    return;
  }
  // sqlite-allow-raw -- Unreleased additive column migration.
  db.exec(
    "ALTER TABLE standing_intents ADD COLUMN creator_sender TEXT " +
      "CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0)",
  );
}

/** Lazily add the canonical standing-intents tables on first feature use. */
export function ensureOpenClawAgentStandingIntentsSchema(db: DatabaseSync): void {
  if (hasCurrentStandingIntentsSchema(db)) {
    return;
  }
  const schemaSql = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, STANDING_INTENTS_TABLE, {
    endMarker: "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
    includeEndMarker: false,
    errorMessage: "OpenClaw standing-intents schema markers are missing.",
  });
  const ensure = () => {
    // sqlite-allow-raw -- Canonical additive DDL only.
    db.exec(schemaSql);
    ensureStandingIntentCreatorColumn(db);
  };
  if (db.isTransaction) {
    ensure();
    // A raw caller transaction has no managed publication scope and earns no lasting cache.
    deferSqlitePostCommitPublication(db, () =>
      rememberCommittedStandingIntentsSchema(db, schemaSql),
    );
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  rememberCommittedStandingIntentsSchema(db, schemaSql);
}
