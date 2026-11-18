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
/** Additive standing-intents columns introduced after the keywords-only schema. */
const locationColumns: Array<{ name: string; sql: string }> = [
  {
    name: "trigger_kind",
    sql: "trigger_kind TEXT CHECK (trigger_kind IS NULL OR trigger_kind IN ('keywords', 'location'))",
  },
  { name: "location_trigger", sql: "location_trigger TEXT" },
  {
    name: "delivery_target",
    sql: "delivery_target TEXT CHECK (delivery_target IS NULL OR length(trim(delivery_target)) > 0)",
  },
  {
    name: "last_inside",
    sql: "last_inside INTEGER CHECK (last_inside IS NULL OR last_inside IN (0, 1))",
  },
];
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
      ).columns.get("creator_sender") !== creatorColumnSql ||
      !locationColumns.every((column) =>
        parseSqliteTableDefinition(
          facts.tableSql.get(STANDING_INTENTS_TABLE) ?? null,
          STANDING_INTENTS_TABLE,
        ).columns.has(column.name),
      ) ||
      !facts.indexes.has("idx_standing_intents_location")
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
      // Add the additive columns BEFORE executing the canonical section:
      // that section contains idx_standing_intents_location, which references
      // trigger_kind and location_trigger. On a pre-location table those
      // columns do not exist yet, so the canonical exec would throw "no such
      // column" — on exactly the databases this ensure exists to repair —
      // before the ALTER loop below could ever run. Columns first, then the
      // canonical DDL installs cleanly.
      const columns =
        /* sqlite-allow-raw -- Native inspection preserves generated-column behavior during repair. */ db
          .prepare("PRAGMA main.table_info(standing_intents)")
          .all();
      if (columns.length > 0) {
        if (!columns.some((column) => column.name === "creator_sender")) {
          // sqlite-allow-raw -- Canonical additive column migration.
          db.exec(`ALTER TABLE main.standing_intents ADD COLUMN ${creatorColumnSql}`);
        }
        const presentColumns = new Set(columns.map((column) => (column as { name: string }).name));
        for (const column of locationColumns) {
          if (!presentColumns.has(column.name)) {
            // sqlite-allow-raw -- Canonical additive column migration.
            db.exec(`ALTER TABLE main.standing_intents ADD COLUMN ${column.sql}`);
          }
        }
      }
      // sqlite-allow-raw -- Canonical additive DDL only.
      db.exec(
        schemaSql.replaceAll(
          /CREATE ((?:VIRTUAL )?TABLE|INDEX|TRIGGER) IF NOT EXISTS /gu,
          "CREATE $1 IF NOT EXISTS main.",
        ),
      );
      // sqlite-allow-raw -- Canonical additive index migration.
      db.exec(
        "CREATE INDEX IF NOT EXISTS main.idx_standing_intents_location ON standing_intents(status, trigger_kind, location_trigger)",
      );
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
