import type { DatabaseSync } from "node:sqlite";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

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
  try {
    const facts = getAdmittedSqliteSchemaFacts(db);
    if (!facts) {
      return false;
    }
    if (admittedSchemas.get(db) === facts) {
      return true;
    }
    if (
      ![
        STANDING_INTENTS_TABLE,
        STANDING_INTENTS_FTS_TABLE,
        ...STANDING_INTENTS_FTS_SHADOW_TABLES,
      ].every((table) => facts.tables.has(table)) ||
      !["idx_standing_intents_lifecycle", "idx_standing_intents_scope"].every((index) =>
        facts.indexes.has(index),
      ) ||
      ![
        "standing_intents_fts_after_insert",
        "standing_intents_fts_after_delete",
        "standing_intents_fts_after_update",
      ].every((trigger) => facts.triggers.has(trigger)) ||
      // Native unqualified lookup preserves TEMP shadowing and generated-column semantics.
      !tableHasColumn(db, STANDING_INTENTS_TABLE, "creator_sender")
    ) {
      return false;
    }
    admittedSchemas.set(db, facts);
    return true;
  } catch {
    // Cache observation cannot replace the schema owner's original SQL outcome.
    return false;
  }
}

/** Lazily add the canonical standing-intents tables on first feature use. */
export function ensureOpenClawAgentStandingIntentsSchema(db: DatabaseSync): void {
  runSqliteReadOperationSync(db, () => {
    if (hasCurrentStandingIntentsSchema(db)) {
      return;
    }
    const ensure = () => {
      // Standalone ensures refresh admission again after acquiring the write transaction.
      if (hasCurrentStandingIntentsSchema(db)) {
        return;
      }
      const schemaSql = extractSqliteTableSchema(
        OPENCLAW_AGENT_SCHEMA_SQL,
        STANDING_INTENTS_TABLE,
        {
          endMarker: "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
          includeEndMarker: false,
          errorMessage: "OpenClaw standing-intents schema markers are missing.",
        },
      );
      // sqlite-allow-raw -- Canonical additive DDL only.
      db.exec(schemaSql);
      ensureColumn(
        db,
        STANDING_INTENTS_TABLE,
        "creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0)",
      );
    };
    if (db.isTransaction) {
      ensure();
    } else {
      runSqliteImmediateTransactionSync(db, ensure);
    }
  });
}
