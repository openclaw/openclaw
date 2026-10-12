import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionPendingInputReceipt } from "./session-history-read.types.js";
import {
  normalizePendingInputReceiptRunIds,
  projectPendingInputReceipts,
} from "./session-pending-input-value.js";

type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
const receiptSchemas = new WeakMap<SqliteSchemaFacts, boolean>();

/** Bounded display reconciliation; these durable correlations never authorize replay. */
export function listSessionPendingInputReceipts(
  scope: PendingInputScope,
  options: { runIds: readonly string[] },
): SessionPendingInputReceipt[] {
  const runIds = normalizePendingInputReceiptRunIds(options.runIds);
  if (!runIds.length) {
    return [];
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const schema = getAdmittedSqliteSchemaFacts(database.db);
    if (!schema) {
      throw new Error("Pending input receipt reads require admitted schema facts");
    }
    let hasReceipts = receiptSchemas.get(schema);
    if (hasReceipts === undefined) {
      const table = schema.tableSql.get("session_pending_inputs");
      hasReceipts =
        table !== undefined &&
        parseSqliteTableDefinition(table, "session_pending_inputs").columns.has(
          "consumed_event_id",
        );
      receiptSchemas.set(schema, hasReceipts);
    }
    if (!hasReceipts) {
      return [];
    }
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .select(["run_id", "consumed_event_id", "state"])
        .where("session_key", "=", resolved.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "in", runIds)
        .orderBy("seq", "asc")
        .limit(51),
    ).rows;
    return projectPendingInputReceipts(rows);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
