import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export const SESSION_PENDING_INPUTS_TABLE = "session_pending_inputs";
export const SESSION_INPUT_COMPLETIONS_TABLE = "session_input_completions";

const ensurePendingTable = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_PENDING_INPUTS_TABLE, {
      endMarker: "-- Processing completion",
      includeEndMarker: false,
      errorMessage: "OpenClaw pending-input schema marker is missing.",
    }),
  {
    tables: [SESSION_PENDING_INPUTS_TABLE],
    indexes: ["idx_agent_session_pending_inputs_session"],
  },
);

/** Read-only callers consume the schema owner's presence facts without installing anything. */
export function hasSessionPendingInputsSchema(db: EngineConnection): boolean {
  return tableExists(db, SESSION_PENDING_INPUTS_TABLE);
}

/** Install canonical first-use storage and migrate older same-version tables. */
export function ensureSessionPendingInputsSchema(db: EngineConnection): void {
  if (isPostgresSqlConnection(db)) {
    return;
  }
  ensurePendingTable(db);
  if (!hasPendingInputConsumptionColumn(db)) {
    runSqliteImmediateTransactionSync(db, () => ensurePendingInputConsumptionColumn(db));
  }
}

/** Completion tracking is opt-in; ordinary input admission does not create this table. */
const ensureInputCompletionsTable = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_INPUT_COMPLETIONS_TABLE, {
      errorMessage: "OpenClaw input-completion schema marker is missing.",
    }),
  { tables: [SESSION_INPUT_COMPLETIONS_TABLE] },
);

export function ensureSessionInputCompletionsSchema(db: EngineConnection): void {
  if (!isPostgresSqlConnection(db)) {
    ensureInputCompletionsTable(db);
  }
}

function ensurePendingInputConsumptionColumn(db: EngineConnection): void {
  ensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");
}

export function hasPendingInputConsumptionColumn(db: EngineConnection): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    const sql = schema.tableSql.get(SESSION_PENDING_INPUTS_TABLE);
    return (
      sql !== undefined &&
      sql !== null &&
      parseSqliteTableDefinition(sql, SESSION_PENDING_INPUTS_TABLE).columns.has("consumed_event_id")
    );
  }
  return tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id");
}
