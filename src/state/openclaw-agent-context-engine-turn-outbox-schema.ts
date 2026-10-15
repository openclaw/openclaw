import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const CONTEXT_ENGINE_TURN_OUTBOX_TABLE = "context_engine_turn_outbox";

/** Lazily installs the additive context-engine turn outbox on first use. */
export const ensureContextEngineTurnOutboxSchema = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, CONTEXT_ENGINE_TURN_OUTBOX_TABLE, {
      endMarker: "CREATE TABLE IF NOT EXISTS cache_entries (",
      includeEndMarker: false,
      errorMessage: "OpenClaw context-engine turn outbox schema markers are missing.",
    }),
  {
    tables: [CONTEXT_ENGINE_TURN_OUTBOX_TABLE],
    indexes: ["idx_agent_context_engine_turn_outbox_engine"],
  },
);
