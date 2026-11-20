import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  readSessionActorTransactionState,
  writableSessionActorMap,
} from "./session-actor-transaction.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";

/** A committed reduction retires persisted input custody before a re-invitation can occur. */
export function revokeSessionParticipationQueueInTransaction(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string; profileId: string },
): void {
  if (!hasSessionPendingInputsSchema(database.db)) return;
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "=", target.sessionKey)
      .where("session_id", "=", target.sessionId)
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null),
  ).rows;
  const actor = readSessionActorTransactionState(database, target);
  for (const row of rows) {
    const ceiling = parseSessionPendingInputMessage(row.message_json).__openclaw
      ?.participationCeiling;
    if (
      ceiling?.kind !== "send" ||
      ceiling.profileId !== target.profileId ||
      ceiling.sessionKey !== target.sessionKey
    )
      continue;
    const changes = { state: "cancelled", end_cause: "revoked", origin_source_json: null };
    withSqliteDatabaseWriteScope(
      database.db,
      [target.sessionKey, sqliteSessionIdWriteScope(target.sessionId)],
      () =>
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_pending_inputs")
            .set(changes)
            .where("input_id", "=", row.input_id)
            .where("state", "=", "queued")
            .where("consumed_event_id", "is", null),
        ),
    );
    if (actor) {
      actor.pendingInputs = writableSessionActorMap(actor.pendingInputs);
      actor.pendingInputs.set(row.idempotency_key, { ...row, ...changes });
    }
  }
}
