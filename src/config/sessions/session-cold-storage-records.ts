import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "../../state/openclaw-agent-db-lease.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionColdRecord } from "./session-cold-storage-codec.js";
import { createSessionTranscriptFtsInserter } from "./session-transcript-fts.js";
import {
  prepareColdTranscriptPayload,
  prepareTranscriptPayloadForReuse,
  TRANSCRIPT_INSERT_BATCH_SIZE,
  type TranscriptPayloadRecord,
  type PreparedTranscriptPayload,
} from "./transcript-payload.js";

export type SessionColdWriteRecord = SessionColdRecord & {
  preparedPayload?: PreparedTranscriptPayload;
};

/** Replay payloads without deleting the navigation that still serves cold readers. */
function createColdEventInserter(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  mode: "restore" | "navigation",
) {
  type Row = TranscriptPayloadRecord & { session_id: string; seq: number; created_at: number };
  const inserts = new Map<number, ReturnType<typeof prepareInsert>>();
  const prepareInsert = (count: number) =>
    prepareSqliteQuerySync<readonly Row[]>(database.db, (parameter) =>
      getNodeSqliteKysely<DB>(database.db)
        .insertInto("transcript_events")
        .values(
          Array.from({ length: count }, (_, index) => ({
            session_id: sessionId,
            seq: parameter((rows) => rows[index]!.seq),
            created_at: parameter((rows) => rows[index]!.created_at),
            event_json: parameter((rows) => rows[index]!.event_json),
            event_zstd: parameter((rows) => rows[index]!.event_zstd),
            event_utf8_bytes: parameter((rows) => rows[index]!.event_utf8_bytes),
            navigation_json: parameter((rows) => rows[index]!.navigation_json),
            navigation_type: parameter((rows) => rows[index]!.navigation_type),
            navigation_custom_type: parameter((rows) => rows[index]!.navigation_custom_type),
            navigation_display: parameter((rows) => rows[index]!.navigation_display),
            message_role: parameter((rows) => rows[index]!.message_role),
            navigation_last_type: parameter((rows) => rows[index]!.navigation_last_type),
            navigation_last_custom_type: parameter(
              (rows) => rows[index]!.navigation_last_custom_type,
            ),
            navigation_valid: parameter((rows) => rows[index]!.navigation_valid),
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["session_id", "seq"]).doUpdateSet((eb) => ({
            event_json: eb.ref("excluded.event_json"),
            event_zstd: eb.ref("excluded.event_zstd"),
            event_utf8_bytes: eb.ref("excluded.event_utf8_bytes"),
            navigation_json: eb.ref("excluded.navigation_json"),
          })),
        ),
    );
  return (
    rows: readonly {
      seq: number;
      createdAt: number;
      eventJson: string;
      preparedPayload?: PreparedTranscriptPayload;
    }[],
  ) => {
    let insert = inserts.get(rows.length);
    if (!insert) {
      insert = prepareInsert(rows.length);
      inserts.set(rows.length, insert);
    }
    insert(
      rows.map((row) => ({
        session_id: sessionId,
        seq: row.seq,
        created_at: row.createdAt,
        ...(mode === "navigation"
          ? prepareColdTranscriptPayload(database.db, row.eventJson)
          : (row.preparedPayload ?? prepareTranscriptPayloadForReuse(database.db, row.eventJson))
              .payload),
      })),
    );
  };
}

/** Restore canonical archive records or publish their derived navigation under the same owner. */
export function writeSessionColdRecordsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  session_id: string,
  records: Iterable<SessionColdWriteRecord>,
  mode: "restore" | "navigation",
): void {
  const db = getNodeSqliteKysely<DB>(database.db);
  const insertEvents = createColdEventInserter(database, session_id, mode);
  const eventRows: Parameters<typeof insertEvents>[0][number][] = [];
  const identityRows: DB["transcript_event_identities"][] = [];
  const activeRows: DB["session_transcript_active_events"][] = [];
  let eventCharacters = 0;
  const flushRows = () => {
    if (eventRows.length) {
      insertEvents(eventRows);
      eventRows.length = 0;
      eventCharacters = 0;
    }
    if (identityRows.length) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("transcript_event_identities")
          .values(identityRows)
          .onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
      );
      identityRows.length = 0;
    }
    if (activeRows.length) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_transcript_active_events")
          .values(activeRows)
          .onConflict((conflict) =>
            conflict.columns(["session_id", "active_position"]).doNothing(),
          ),
      );
      activeRows.length = 0;
    }
  };
  const insertFts = createSessionTranscriptFtsInserter(database.db, session_id);
  const ftsRows: Parameters<typeof insertFts>[0][number][] = [];
  let previousKind: SessionColdRecord["kind"] | undefined;
  let renewedAt = performance.now();
  for (const record of records) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    // Keep archive order and immediate foreign keys, including across chunk boundaries.
    if (record.kind !== previousKind) {
      flushRows();
      previousKind = record.kind;
    }
    switch (record.kind) {
      case "header":
        break;
      case "event":
        eventRows.push({
          seq: record.row.seq,
          createdAt: record.row.created_at,
          eventJson: record.row.event_json,
          preparedPayload: record.preparedPayload,
        });
        eventCharacters += record.row.event_json.length;
        // Bound retained decoded text to about 1 MiB, plus one oversized event.
        // Smaller payload batches also fit the native statement cache's binding budget.
        if (eventRows.length === 64 || eventCharacters >= 524_288) {
          flushRows();
        }
        break;
      case "identity":
        identityRows.push({ session_id, ...record.row });
        if (identityRows.length === TRANSCRIPT_INSERT_BATCH_SIZE) {
          flushRows();
        }
        break;
      case "active":
        activeRows.push({ session_id, ...record.row });
        if (activeRows.length === TRANSCRIPT_INSERT_BATCH_SIZE) {
          flushRows();
        }
        break;
      case "index":
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("session_transcript_index_state")
            .values({ session_id, ...record.row })
            .onConflict((conflict) => conflict.column("session_id").doUpdateSet(record.row)),
        );
        break;
      case "fts":
        if (mode === "navigation") {
          break;
        }
        ftsRows.push({
          messageId: record.row.message_id,
          text: record.row.text,
          role: record.row.role,
          timestamp: record.row.timestamp,
        });
        if (ftsRows.length === TRANSCRIPT_INSERT_BATCH_SIZE) {
          insertFts(ftsRows);
          ftsRows.length = 0;
        }
        break;
    }
  }
  flushRows();
  insertFts(ftsRows);
}
