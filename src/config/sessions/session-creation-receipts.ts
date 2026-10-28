import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionKeyBySessionIdInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  assertSessionCreationOperationTime,
  SessionCreationOperationError,
  type SessionCreationOperation,
} from "./session-creation-operation.js";

/** The read snapshot and final session writer share one receipt interpretation. */
export function inspectSessionCreationReceipt(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sessionKey: string,
  operation: SessionCreationOperation,
): boolean {
  const now = Date.now();
  assertSessionCreationOperationTime(operation, now);
  if (
    !/^[a-f0-9]{64}$/.test(operation.digest) ||
    !/^[a-f0-9]{64}$/.test(operation.requestFingerprint)
  ) {
    throw new SessionCreationOperationError(
      "creation-operation-invalid",
      "Invalid native creation binding.",
    );
  }
  const query = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  const receipt = executeSqliteQueryTakeFirstSync(
    database.db,
    query
      .selectFrom("session_creation_operations")
      .selectAll()
      .where("operation_digest", "=", operation.digest),
  );
  const existing = readExactSessionEntryRow(database, sessionKey, "full", undefined, true)?.entry;
  if (receipt) {
    if (
      receipt.request_fingerprint !== operation.requestFingerprint ||
      receipt.session_id !== operation.sessionId ||
      receipt.expires_at !== operation.expiresAt
    ) {
      throw new SessionCreationOperationError(
        "creation-operation-conflict",
        "Creation operation was already bound to different arguments.",
      );
    }
    const physicalOwner = readSessionKeyBySessionIdInDatabase(database, receipt.session_id);
    if (physicalOwner !== undefined && physicalOwner !== sessionKey) {
      throw new SessionCreationOperationError(
        "creation-session-unavailable",
        "The original physical session belongs to another native target.",
      );
    }
    if (
      existing?.sessionId !== receipt.session_id ||
      existing.lifecycleRevision !== receipt.session_id
    ) {
      throw new SessionCreationOperationError(
        "creation-session-unavailable",
        "The original creation incarnation is no longer available.",
      );
    }
    return true;
  }
  if (existing) {
    throw new SessionCreationOperationError(
      "creation-operation-conflict",
      "Creation cannot adopt an existing session.",
    );
  }
  const physicalOwner = readSessionKeyBySessionIdInDatabase(database, operation.sessionId);
  const physicalReceipt = executeSqliteQueryTakeFirstSync(
    database.db,
    query
      .selectFrom("session_creation_operations")
      .select("operation_digest")
      .where("session_id", "=", operation.sessionId),
  );
  if (physicalOwner || physicalReceipt) {
    throw new SessionCreationOperationError(
      "creation-operation-conflict",
      "Creation cannot adopt an existing physical session.",
    );
  }
  return false;
}

/** The original session transaction owns receipt and row atomicity. */
export function commitSessionCreationReceipt(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  operation: SessionCreationOperation,
): boolean {
  assertSessionCreationOperationTime(operation, Date.now());
  if (inspectSessionCreationReceipt(database, sessionKey, operation)) {
    return true;
  }
  const now = Date.now();
  const query = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  // Expired identities are rejected above even after this native pruning removes their receipt.
  executeSqliteQuerySync(
    database.db,
    query.deleteFrom("session_creation_operations").where("expires_at", "<=", now),
  );
  executeSqliteQuerySync(
    database.db,
    query.insertInto("session_creation_operations").values({
      operation_digest: operation.digest,
      request_fingerprint: operation.requestFingerprint,
      session_id: operation.sessionId,
      expires_at: operation.expiresAt,
    }),
  );
  return false;
}
