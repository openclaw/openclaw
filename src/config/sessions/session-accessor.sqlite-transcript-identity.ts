import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { TRANSCRIPT_INSERT_BATCH_SIZE, transcriptEventJsonSql } from "./transcript-payload.js";

export type TranscriptIdentityInsertRow = NonNullable<
  ReturnType<typeof readTranscriptEventIdentity>
> & { seq: number; createdAt: number };

export function createTranscriptIdentityInserter(
  database: OpenClawAgentDatabase,
  sessionId: string,
  ignoreConflicts: boolean,
) {
  // Each executor is used only with the chunk length that defines its bound indexes.
  const prepare = (count: number) =>
    prepareSqliteQuerySync<readonly TranscriptIdentityInsertRow[]>(database.db, (parameter) =>
      getSessionKysely(database.db)
        .insertInto("transcript_event_identities")
        .values(
          Array.from({ length: count }, (_, index) => ({
            session_id: sessionId,
            event_id: parameter((rows) => rows[index]!.eventId),
            seq: parameter((rows) => rows[index]!.seq),
            event_type: parameter((rows) => rows[index]!.eventType),
            parent_id: parameter((rows) => rows[index]!.parentId),
            // An unowned key is SQL NULL, also the schema default when previously omitted.
            message_idempotency_key: parameter((rows) => rows[index]!.messageIdempotencyKey),
            created_at: parameter((rows) => rows[index]!.createdAt),
          })),
        )
        .$if(ignoreConflicts, (query) =>
          query.onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
        ),
    );
  const inserts = new Map<number, ReturnType<typeof prepare>>();
  const batch = (rows: readonly TranscriptIdentityInsertRow[]) => {
    for (let offset = 0; offset < rows.length; offset += TRANSCRIPT_INSERT_BATCH_SIZE) {
      const chunk = rows.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE);
      let insert = inserts.get(chunk.length);
      if (!insert) {
        insert = prepare(chunk.length);
        inserts.set(chunk.length, insert);
      }
      insert(chunk);
    }
  };
  return Object.assign((row: TranscriptIdentityInsertRow) => batch([row]), { batch });
}

/** Prepared arrays can resolve all conflicts before their synchronous append loop. */
export function readTranscriptAppendIdentities(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  eventIds: readonly string[],
  keys: readonly string[],
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor?.transcript.complete) {
    const selected = new Map(
      eventIds.flatMap((eventId) => {
        const row = actor.transcript.identities.get(eventId);
        return row ? [[eventId, row] as const] : [];
      }),
    );
    const remainingKeys = new Set(keys);
    if (remainingKeys.size > 0) {
      for (const row of actor.transcript.identities.values()) {
        if (
          row.message_idempotency_key !== null &&
          remainingKeys.delete(row.message_idempotency_key)
        ) {
          selected.set(row.event_id, row);
          if (remainingKeys.size === 0) {
            break;
          }
        }
      }
    }
    return [...selected.values()];
  }
  return executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq", "message_idempotency_key"])
      .where("session_id", "=", sessionId)
      .where((eb) => {
        const keyMatch =
          keys.length === 0
            ? eb.lit(false)
            : eb("message_idempotency_key", "in", keys.length <= 64 ? keys : sqliteStringSet(keys));
        return eventIds.length > 0
          ? eb.or([eb("event_id", "in", sqliteStringSet(eventIds)), keyMatch])
          : keyMatch;
      }),
  ).rows;
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
    if (row || actor.transcript.complete) {
      return row ? { eventId: row.event_id, seq: row.seq } : undefined;
    }
  }
  const row = readTranscriptAppendIdentities(database, sessionId, [], [idempotencyKey])[0];
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

export function readTranscriptMessageByIdentity(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: ResolvedTranscriptScope,
  identity: { eventId: string; seq: number },
): { messageId: string; message: unknown } | undefined {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor?.transcript.payloads.has(identity.seq)) {
    const event = actor.transcript.payloads.get(identity.seq)?.event;
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

export function readTranscriptMessageByEventId(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByEventId(database, scope.sessionId, eventId);
  return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
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
