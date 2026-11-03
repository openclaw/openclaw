// Continuation (karmaterminal): recipient-authority reads and captures run only in the session
// sharing worker (session-sharing-store.worker.ts), never on the Gateway thread. Epoch advances
// stay in their writers' own transactions (session-accessor.sqlite-recipient-authority.ts).
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  advanceSessionRecipientAuthorityInTransaction,
  getSessionRecipientAuthorityKysely,
} from "./session-accessor.sqlite-recipient-authority.js";
import {
  readSessionRecipientAuthorityEpoch,
  type SessionRecipientAuthority,
  type SessionRecipientAuthorityRecordState,
} from "./session-recipient-authority-types.js";

export function readSessionRecipientAuthorityEpochInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): SessionRecipientAuthorityRecordState {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionRecipientAuthorityKysely(database)
      .selectFrom("session_recipient_authority")
      .select(["epoch", "created_at", "updated_at"])
      .where("session_key", "=", sessionKey),
  );
  if (!row) {
    return { state: "missing" };
  }
  const epoch = readSessionRecipientAuthorityEpoch(row.epoch);
  return epoch.state === "present"
    ? { ...epoch, createdAt: row.created_at, updatedAt: row.updated_at }
    : epoch;
}

/**
 * Insert-if-absent inside the caller's immediate write transaction. A missing row
 * cannot appear between the read and the upsert, so initializing through the
 * advance upsert writes exactly what an insert would.
 */
export function captureSessionRecipientAuthorityInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): SessionRecipientAuthority {
  const current = readSessionRecipientAuthorityEpochInDatabase(database, sessionKey);
  if (current.state === "malformed") {
    throw new Error(`Invalid recipient authority epoch for session ${sessionKey}`);
  }
  if (current.state === "present") {
    return { state: "bound", epoch: current.epoch };
  }
  return {
    state: "bound",
    epoch: advanceSessionRecipientAuthorityInTransaction(database, sessionKey),
  };
}
