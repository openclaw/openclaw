import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export function createTranscriptIdentityInserter(
  database: OpenClawAgentDatabase,
  sessionId: string,
  ignoreConflicts: boolean,
) {
  return prepareSqliteQuerySync<
    NonNullable<ReturnType<typeof readTranscriptEventIdentity>> & { seq: number; createdAt: number }
  >(database.db, (parameter) =>
    getSessionKysely(database.db)
      .insertInto("transcript_event_identities")
      .values({
        session_id: sessionId,
        event_id: parameter((row) => row.eventId),
        seq: parameter((row) => row.seq),
        event_type: parameter((row) => row.eventType),
        parent_id: parameter((row) => row.parentId),
        // An unowned key is SQL NULL, also the schema default when previously omitted.
        message_idempotency_key: parameter((row) => row.messageIdempotencyKey),
        created_at: parameter((row) => row.createdAt),
      })
      .$if(ignoreConflicts, (query) =>
        query.onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
      ),
  );
}

export function readIdempotencyKeyOwner(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  idempotencyKey: string,
): { eventId: string; seq: number } | undefined {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    const row = [...actor.transcript.identities.values()].findLast(
      (candidate) => candidate.message_idempotency_key === idempotencyKey,
    );
    return row ? { eventId: row.event_id, seq: row.seq } : undefined;
  }
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

export function readTranscriptMessageByIdentity(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: ResolvedTranscriptScope,
  identity: { eventId: string; seq: number },
): { messageId: string; message: unknown } | undefined {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor?.transcript.payloads.has(identity.seq)) {
    const event = actor.transcript.payloads.get(identity.seq);
    return { messageId: identity.eventId, message: isRecord(event) ? event.message : undefined };
  }
  const db = getSessionKysely(database.db);
  const eventRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", identity.seq),
  );
  if (!eventRow) {
    return undefined;
  }
  // SAFETY: Identity rows are created only for canonical object events; message stays unknown.
  const event = JSON.parse(eventRow.event_json) as { message?: unknown };
  return { messageId: identity.eventId, message: event.message };
}

export function readTranscriptEventIdentity(event: unknown) {
  if (!isRecord(event)) {
    return undefined;
  }
  const eventId = typeof event.id === "string" && event.id.trim() ? event.id.trim() : undefined;
  return eventId
    ? {
        eventId,
        eventType: typeof event.type === "string" ? event.type : null,
        parentId: typeof event.parentId === "string" ? event.parentId : null,
        messageIdempotencyKey: readMessageIdempotencyKey(event.message),
      }
    : undefined;
}
