import type { DatabaseSync } from "node:sqlite";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
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

const creatorColumnSql =
  "creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0)";
const admittedSchemas = new WeakSet<SqliteSchemaFacts>();

function hasCurrentStandingIntentsSchema(db: DatabaseSync): boolean {
  try {
    const facts = getAdmittedSqliteSchemaFacts(db);
    if (!facts) {
      return false;
    }
    if (admittedSchemas.has(facts)) {
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
      parseSqliteTableDefinition(
        facts.tableSql.get(STANDING_INTENTS_TABLE) ?? null,
        STANDING_INTENTS_TABLE,
      ).columns.get("creator_sender") !== creatorColumnSql
    ) {
      return false;
    }
    admittedSchemas.add(facts);
    return true;
  } catch {
    // Cache observation cannot replace the schema owner's original SQL outcome.
    return false;
  }
}

/** The optional synchronous owner supplies write grants only when main-schema DDL is needed. */
export function ensureOpenClawAgentStandingIntentsSchema(
  db: DatabaseSync,
  transact?: <T>(run: () => T) => T,
): void {
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
      // TEMP objects must not redirect installation away from the canonical agent schema.
      // sqlite-allow-raw -- Canonical additive DDL only.
      db.exec(
        schemaSql.replaceAll(
          /CREATE ((?:VIRTUAL )?TABLE|INDEX|TRIGGER) IF NOT EXISTS /gu,
          "CREATE $1 IF NOT EXISTS main.",
        ),
      );
      const columns =
        /* sqlite-allow-raw -- Native inspection preserves generated-column behavior during repair. */ db
          .prepare("PRAGMA main.table_info(standing_intents)")
          .all();
      if (!columns.some((column) => column.name === "creator_sender")) {
        // sqlite-allow-raw -- Canonical additive column migration.
        db.exec(`ALTER TABLE main.standing_intents ADD COLUMN ${creatorColumnSql}`);
      }
    };
    if (db.isTransaction) {
      ensure();
    } else if (transact) {
      transact(ensure);
    } else {
      runSqliteImmediateTransactionSync(db, ensure);
    }
  });
}
