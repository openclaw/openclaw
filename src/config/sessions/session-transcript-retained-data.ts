import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type AliasableExpression } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SqliteTranscriptStorageRow } from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readNextTranscriptSeq } from "./session-accessor.sqlite-transcript-state.js";

/** Custom data is opaque to topology and indexing; cleanup keeps it in SQLite. */
export function projectTranscriptRetainedDataSql(
  event: AliasableExpression<string>,
  retainedIds: readonly string[],
): AliasableExpression<string> {
  return retainedIds.length === 0
    ? event
    : /* kysely-allow-raw: bound cleanup planning to navigation while retaining opaque custom data in its original row. */ sql<string>`CASE WHEN json_valid(${event}) THEN
        CASE WHEN json_extract(${event}, '$.type') = 'custom'
          AND json_extract(${event}, '$.id') IN (${sql.join(retainedIds)})
        THEN json_remove(${event}, '$.data') ELSE ${event} END
      ELSE ${event} END`;
}

/** Stage opaque payloads inside the same transaction before their old suffix rows are removed. */
export function stageRetainedTranscriptData(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expectedRows: readonly SqliteTranscriptStorageRow[],
  next: readonly TranscriptEvent[],
  retainedIds: readonly string[],
): { startSeq: number; sources: Map<number, number> } | undefined {
  if (retainedIds.length === 0) {
    return undefined;
  }
  const retained = new Set(retainedIds);
  const originals = new Map(
    expectedRows.flatMap((row) => {
      const event: unknown = JSON.parse(row.eventJson);
      return isRecord(event) &&
        event.type === "custom" &&
        typeof event.id === "string" &&
        retained.has(event.id)
        ? [[event.id, { row, event }] as const]
        : [];
    }),
  );
  const copies = next.flatMap((event, index) => {
    if (
      !isRecord(event) ||
      event.type !== "custom" ||
      typeof event.id !== "string" ||
      !retained.has(event.id)
    ) {
      return [];
    }
    const original = originals.get(event.id);
    if (!original) {
      throw new Error("Retained transcript data has no original suffix row");
    }
    const { parentId: _oldParent, ...before } = original.event;
    const { parentId, ...after } = event;
    if (
      Object.hasOwn(before, "data") ||
      Object.hasOwn(after, "data") ||
      !isDeepStrictEqual(before, after) ||
      (parentId !== null && typeof parentId !== "string")
    ) {
      throw new Error("Retained transcript data permits only parent repair");
    }
    return [{ index, sourceSeq: original.row.seq, parentId }];
  });
  if (copies.length === 0) {
    return undefined;
  }
  // Staging uses otherwise vacant sequence positions, never another table or persistent format.
  // All rows are removed before COMMIT; rollback also restores the original suffix atomically.
  const startSeq = readNextTranscriptSeq(database, sessionId) + next.length;
  const sources = new Map<number, number>();
  for (const [offset, copy] of copies.entries()) {
    const stagedSeq = startSeq + offset;
    copyRetainedTranscriptPayload(database, sessionId, copy.sourceSeq, stagedSeq, copy.parentId);
    sources.set(copy.index, stagedSeq);
  }
  return { startSeq, sources };
}

/** Copy a transaction-owned payload without materializing it in JavaScript. */
export function copyRetainedTranscriptPayload(
  database: OpenClawAgentDatabase,
  sessionId: string,
  sourceSeq: number,
  destinationSeq: number,
  parentId?: string | null,
): void {
  const db = getSessionKysely(database.db);
  const copied = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_events")
      .columns(["session_id", "seq", "event_json", "created_at"])
      .expression(
        db
          .selectFrom("transcript_events")
          .select((eb) => {
            const eventJson: AliasableExpression<string> =
              parentId === undefined
                ? eb.ref("event_json")
                : /* kysely-allow-raw: reparent only the envelope; opaque data stays in SQLite. */ sql<string>`json_set(event_json, '$.parentId', ${parentId})`;
            return [
              eb.val(sessionId).as("session_id"),
              eb.val(destinationSeq).as("seq"),
              eventJson.as("event_json"),
              "created_at",
            ];
          })
          .where("session_id", "=", sessionId)
          .where("seq", "=", sourceSeq),
      ),
  );
  if (copied.numAffectedRows !== 1n) {
    throw new Error("Retained transcript payload disappeared during suffix insertion");
  }
}
