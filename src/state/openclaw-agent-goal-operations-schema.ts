import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_GOAL_OPERATIONS_TABLE = "session_goal_operations";

/** First typed Goal use installs the additive receipt table, without a version bump. */
export const ensureSessionGoalOperationsSchema = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_GOAL_OPERATIONS_TABLE, {
      endMarker: "CREATE TABLE IF NOT EXISTS transcript_events (",
      includeEndMarker: false,
      errorMessage: "OpenClaw Goal operation schema markers are missing.",
    }),
  {
    tables: [SESSION_GOAL_OPERATIONS_TABLE],
    indexes: ["idx_agent_session_goal_operations_expiry"],
  },
);
