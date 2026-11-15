import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { jsonNativeFieldsValid } from "../../infra/database-engine/json-values.js";
import {
  prepareSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-state.js";
import { projectTranscriptPayloadNavigationSql } from "./session-model-context-projection.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

export const SESSION_MESSAGE_CUT_MAX_BYTES = 8 * 1024 * 1024;

/** Keep message bodies out of the tree planner and hydrate only the row being copied. */
export function readSessionMessageCut(
  database: OpenClawAgentDatabase,
  sessionId: string,
  entryId: string,
) {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const source = getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .where("session_id", "=", sessionId);
    const navigation = transcriptEventNavigationSql(database.db);
    const projected = /* kysely-allow-raw: preserve exceptional JSON while projecting legacy identity rows natively. */ sql<string>`CASE WHEN navigation_json IS NOT NULL THEN ${navigation}
      WHEN ${jsonNativeFieldsValid(database.db, navigation)} THEN ${projectTranscriptPayloadNavigationSql(database.db, navigation)} ELSE ${navigation} END`;
    const rows = iterateSqliteQuerySync(
      database.db,
      source
        .select([
          "seq",
          transcriptEventReadBytesSql().as("payload_bytes"),
          /* kysely-allow-raw: refuse a giant identity payload before it enters the shared worker heap. */ sql<
            string | null
          >`CASE WHEN ${transcriptEventReadBytesSql()} <= ${SESSION_MESSAGE_CUT_MAX_BYTES} THEN ${projected} END`.as(
            "event_json",
          ),
        ])
        .orderBy("seq", "asc"),
    );
    const events: TranscriptEvent[] = [];
    const sequences = new Map<TranscriptEvent, number>();
    const identities = new Map<string, number>();
    const readRow = prepareSqliteQueryTakeFirstSync<number, { event_json: string }>(
      database.db,
      (parameter) =>
        source.select(transcriptEventJsonSql(database.db).as("event_json")).where(
          "seq",
          "=",
          parameter((seq) => seq),
        ),
    );
    const read = (seq: number): TranscriptEvent => JSON.parse(readRow(seq)!.event_json);
    let bytes = 0;
    let payloadBytes = 0;
    for (const row of rows) {
      if (
        row.event_json === null ||
        (bytes += Buffer.byteLength(row.event_json)) > SESSION_MESSAGE_CUT_MAX_BYTES ||
        events.length >= 100_000
      ) {
        throw new SqliteJsonlReadBudgetExceededError(
          "Session history navigation exceeds its safe memory budget (8 MiB per event, 8 MiB of navigation, 100000 events); export the transcript to inspect it without changing this session.",
        );
      }
      payloadBytes += row.payload_bytes;
      let event: TranscriptEvent = JSON.parse(row.event_json);
      // The header's lineage and the selected user's editor content are part of the result.
      if (isRecord(event) && (event.type === "session" || event.id === entryId)) {
        bytes += row.payload_bytes;
        if (bytes > SESSION_MESSAGE_CUT_MAX_BYTES) {
          throw new SqliteJsonlReadBudgetExceededError(
            "Session history editor/header content exceeds the 8 MiB navigation budget",
          );
        }
        event = read(row.seq);
      }
      events.push(event);
      sequences.set(event, row.seq);
      if (isRecord(event) && typeof event.id === "string") {
        identities.set(event.id, row.seq);
      }
    }
    return {
      events,
      payloadBytes,
      *hydrate(selected: readonly TranscriptEvent[]) {
        for (const event of selected) {
          const originalSeq = sequences.get(event);
          // Fork planning may repair a copied node's parent through a leaf control.
          const seq =
            originalSeq ??
            (isRecord(event) && typeof event.id === "string"
              ? identities.get(event.id)
              : undefined);
          if (seq === undefined) {
            yield event;
          } else {
            const original = read(seq);
            yield originalSeq === undefined && isRecord(original) && isRecord(event)
              ? { ...original, parentId: event.parentId }
              : original;
          }
        }
      },
    };
  });
}
