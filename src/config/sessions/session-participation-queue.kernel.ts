import { decodeQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.codec.js";
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
import { matchesSessionParticipationRevocation } from "./session-participation-source.js";
import { markParticipationRevokedMessageJson } from "./session-pending-input-audience.js";

/** A committed reduction retires persisted input custody before a re-invitation can occur. */
export function revokeSessionParticipationQueueInTransaction(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string; profileId: string },
): void {
  if (!hasSessionPendingInputsSchema(database.db)) {
    return;
  }
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null),
  ).rows;
  for (const row of rows) {
    if (!row.origin_source_json) {
      continue;
    }
    let source;
    try {
      source = decodeQueuedOperatorRecoverySource(JSON.parse(row.origin_source_json));
    } catch {
      continue;
    }
    const ceiling = source.kind === "gateway" ? source.snapshot.participationCeiling : undefined;
    if (ceiling?.kind !== "send" || !matchesSessionParticipationRevocation(ceiling, target)) {
      continue;
    }
    const changes = {
      state: "cancelled",
      end_cause: "revoked",
      origin_source_json: null,
      message_json: markParticipationRevokedMessageJson(row.message_json),
    };
    withSqliteDatabaseWriteScope(
      database.db,
      [row.session_key, sqliteSessionIdWriteScope(row.session_id)],
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
    const actor = readSessionActorTransactionState(database, {
      sessionKey: row.session_key,
      sessionId: row.session_id,
    });
    if (actor) {
      actor.pendingInputs = writableSessionActorMap(actor.pendingInputs);
      actor.pendingInputs.set(row.idempotency_key, { ...row, ...changes });
    }
  }
}
