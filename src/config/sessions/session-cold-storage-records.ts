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
  createTranscriptEventInserter,
  prepareColdTranscriptPayload,
  TRANSCRIPT_INSERT_BATCH_SIZE,
  type TranscriptPayloadRecord,
} from "./transcript-payload.js";

/** Cold archives already own the bodies; insert only their native navigation and inline exceptions. */
function createNavigationInserter(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
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
            event_zstd: null,
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
        ),
    );
  return (rows: readonly { seq: number; createdAt: number; eventJson: string }[]) => {
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
        ...prepareColdTranscriptPayload(database.db, row.eventJson),
      })),
    );
  };
}

/** Restore canonical archive records or publish their derived navigation under the same owner. */
export function writeSessionColdRecordsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  session_id: string,
  records: Iterable<SessionColdRecord>,
  mode: "restore" | "navigation",
): void {
  const db = getNodeSqliteKysely<DB>(database.db);
  const insertEvents =
    mode === "navigation"
      ? createNavigationInserter(database, session_id)
      : createTranscriptEventInserter(database.db, session_id).batch;
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
        db.insertInto("transcript_event_identities").values(identityRows),
      );
      identityRows.length = 0;
    }
    if (activeRows.length) {
      executeSqliteQuerySync(
        database.db,
        db.insertInto("session_transcript_active_events").values(activeRows),
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
          db.insertInto("session_transcript_index_state").values({ session_id, ...record.row }),
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
