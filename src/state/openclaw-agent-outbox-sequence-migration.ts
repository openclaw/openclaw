import type { DatabaseSync } from "node:sqlite";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export { withoutOutboxEnqueueSequence } from "./openclaw-agent-schema-history.js";

/** Rebuild within the schema owner's exclusive migration transaction. */
export function migrateOutboxEnqueueSequenceInTransaction(database: DatabaseSync): number | null {
  if (
    !tableExists(database, "context_engine_turn_outbox") ||
    tableHasColumn(database, "context_engine_turn_outbox", "enqueue_sequence")
  ) {
    return null;
  }
  const started = performance.now();
  // Preserve original SQL for witnesses; the contract reader normalizes it.
  const facts = getAdmittedSqliteSchemaFacts(database) ?? captureSqliteSchemaFacts(database);
  const objects = [...facts.indexDefinitions.values(), ...facts.triggers.values()].filter(
    ({ table }) => table === "context_engine_turn_outbox",
  );
  const schema = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "context_engine_turn_outbox");
  database.exec(`
    ${schema.replace("IF NOT EXISTS context_engine_turn_outbox", "context_engine_turn_outbox_sequence_migration")}
    INSERT INTO context_engine_turn_outbox_sequence_migration
      (enqueue_sequence, advancement_key, engine_id, owner_plugin_id, session_id,
       payload_json, payload_state, attempt_count, last_attempt_at, last_error, created_at)
    SELECT rowid, advancement_key, engine_id, owner_plugin_id, session_id,
       payload_json, payload_state, attempt_count, last_attempt_at, last_error, created_at
    FROM context_engine_turn_outbox;
    DROP TABLE context_engine_turn_outbox;
    ALTER TABLE context_engine_turn_outbox_sequence_migration RENAME TO context_engine_turn_outbox;
  `);
  for (const object of objects) {
    // Recreate after copying, so triggers cannot replay effects.
    if (object.sql !== null) {
      database.exec(object.sql);
    }
  }
  return performance.now() - started;
}
