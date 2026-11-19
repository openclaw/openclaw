import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export { AGENT_LOCATION_INTENTS_SCHEMA_VERSION } from "./openclaw-schema-versions.js";

/** Historical (pre-location) SQLite shape: the four columns and index are absent. */
export function withoutAgentLocationIntents(schema: string): string {
  // The location columns are the table's final columns, so removing them must
  // also restore source_session_id as the last column (no trailing comma).
  // Strip the whole tail block atomically: a line-by-line strip would leave
  // a dangling comma after source_session_id and an invalid table.
  return schema
    .replace(
      `  source_session_id TEXT,
  trigger_kind TEXT CHECK (trigger_kind IS NULL OR trigger_kind IN ('keywords', 'location')),
  location_trigger TEXT,
  delivery_target TEXT CHECK (delivery_target IS NULL OR length(trim(delivery_target)) > 0),
  last_inside INTEGER CHECK (last_inside IS NULL OR last_inside IN (0, 1))
) STRICT;`,
      "  source_session_id TEXT\n) STRICT;",
    )
    .replace(
      "CREATE INDEX IF NOT EXISTS idx_standing_intents_location\n  ON standing_intents(status, trigger_kind, location_trigger);\n",
      "",
    );
}

/** Historical (pre-location) PostgreSQL shape: the four columns, their checks, and the index are absent. */
export function withoutAgentPostgresLocationIntents(schema: string): string {
  return schema
    .replace('  "trigger_kind" text COLLATE "C",\n', "")
    .replace('  "location_trigger" text COLLATE "C",\n', "")
    .replace('  "delivery_target" text COLLATE "C",\n', "")
    .replace('  "last_inside" bigint,\n', "")
    .replace(
      "  CHECK (\"trigger_kind\" IS NULL OR (\"trigger_kind\" IN ('keywords', 'location'))),\n",
      "",
    )
    .replace(
      '  CHECK ("delivery_target" IS NULL OR (char_length(btrim("delivery_target")) > 0)),\n',
      "",
    )
    .replace('  CHECK ("last_inside" IS NULL OR ("last_inside" IN (0, 1))),\n', "")
    .replace(
      'CREATE INDEX "idx_standing_intents_location" ON "standing_intents" (("status") ASC, ("trigger_kind") ASC NULLS FIRST, ("location_trigger") ASC NULLS FIRST);\n',
      "",
    );
}

/**
 * The versioned SQLite owner. Existing standing_intents tables gain the four
 * additive location columns; the location index installs after the columns
 * exist. A table absent entirely is created by the canonical DDL with the
 * columns already present.
 */
export function migrateAgentLocationIntentsInTransaction(database: DatabaseSync): void {
  if (!tableExists(database, "standing_intents")) {
    return;
  }
  ensureColumn(
    database,
    "standing_intents",
    "trigger_kind TEXT CHECK (trigger_kind IS NULL OR trigger_kind IN ('keywords', 'location'))",
  );
  ensureColumn(database, "standing_intents", "location_trigger TEXT");
  ensureColumn(
    database,
    "standing_intents",
    "delivery_target TEXT CHECK (delivery_target IS NULL OR length(trim(delivery_target)) > 0)",
  );
  ensureColumn(
    database,
    "standing_intents",
    "last_inside INTEGER CHECK (last_inside IS NULL OR last_inside IN (0, 1))",
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_standing_intents_location ON standing_intents(status, trigger_kind, location_trigger)",
  );
}

export const AGENT_LOCATION_INTENTS_POSTGRES_MIGRATION_SQL = `
DO $standing_intents_location$
BEGIN
  IF to_regclass('standing_intents') IS NOT NULL THEN
    ALTER TABLE standing_intents ADD COLUMN IF NOT EXISTS trigger_kind TEXT COLLATE "C";
    ALTER TABLE standing_intents ADD COLUMN IF NOT EXISTS location_trigger TEXT COLLATE "C";
    ALTER TABLE standing_intents ADD COLUMN IF NOT EXISTS delivery_target TEXT COLLATE "C";
    ALTER TABLE standing_intents ADD COLUMN IF NOT EXISTS last_inside BIGINT;
    -- Checks are created validated (no NOT VALID): existing rows hold NULL
    -- in the new columns, which satisfies each IS NULL guard trivially, and
    -- verifyAndRecordPostgresSchema compares exact constraint definitions —
    -- pg_get_constraintdef would record a NOT VALID suffix as drift.
    ALTER TABLE standing_intents
      ADD CONSTRAINT standing_intents_trigger_kind_check
      CHECK (trigger_kind IS NULL OR (trigger_kind IN ('keywords', 'location')));
    ALTER TABLE standing_intents
      ADD CONSTRAINT standing_intents_delivery_target_check
      CHECK (delivery_target IS NULL OR (char_length(btrim(delivery_target)) > 0));
    ALTER TABLE standing_intents
      ADD CONSTRAINT standing_intents_last_inside_check
      CHECK (last_inside IS NULL OR (last_inside IN (0, 1)));
    -- NULLS FIRST matches the canonical DDL's index exactly: PostgreSQL's
    -- default is NULLS LAST, pg_get_indexdef records the difference, and
    -- verifyAndRecordPostgresSchema rejects any index-definition drift.
    CREATE INDEX IF NOT EXISTS idx_standing_intents_location
      ON standing_intents (status ASC, trigger_kind ASC NULLS FIRST, location_trigger ASC NULLS FIRST);
  END IF;
END
$standing_intents_location$;
`;
