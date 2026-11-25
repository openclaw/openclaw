import {
  importLegacyMemberQueuedSource,
  type LegacyOpenClawIdMemberRoleImport,
} from "../../gateway/openclaw-id/member-source-role-import.js";
import { decodeQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.codec.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

/** Representation-only upgrade within the owning entry's fenced replacement transaction. */
export function importPendingInputMemberRoleSources(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  input: LegacyOpenClawIdMemberRoleImport,
): void {
  if (!hasSessionPendingInputsSchema(database.db)) {
    return;
  }
  const query = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    query
      .selectFrom("session_pending_inputs")
      .select(["input_id", "origin_source_json"])
      .where("session_key", "=", target.sessionKey)
      .where("session_id", "=", target.sessionId)
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null)
      .where("origin_source_json", "is not", null),
  ).rows;
  for (const row of rows) {
    let source;
    try {
      source = decodeQueuedOperatorRecoverySource(JSON.parse(row.origin_source_json!));
    } catch {
      // Invalid stored sources stay invalid; migration does not manufacture authority.
      continue;
    }
    const next = importLegacyMemberQueuedSource(source, input);
    if (next === source) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      query
        .updateTable("session_pending_inputs")
        .set({ origin_source_json: JSON.stringify(next) })
        .where("input_id", "=", row.input_id)
        .where("session_key", "=", target.sessionKey)
        .where("session_id", "=", target.sessionId),
    );
  }
}
