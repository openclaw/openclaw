import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "../../state/openclaw-agent-db-lease.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionColdRecord } from "./session-cold-storage-codec.js";
import { createSessionTranscriptFtsInserter } from "./session-transcript-fts.js";
import {
  createTranscriptEventInserter,
  TRANSCRIPT_INSERT_BATCH_SIZE,
} from "./transcript-payload.js";

/** Restore canonical archive records or publish their derived navigation under the same owner. */
export function writeSessionColdRecordsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  session_id: string,
  records: Iterable<SessionColdRecord>,
  mode: "restore" | "navigation",
): void {
  const db = getNodeSqliteKysely<DB>(database.db);
  const insertEvents = createTranscriptEventInserter(database.db, session_id);
  const eventRows: Parameters<typeof insertEvents.batch>[0][number][] = [];
  const identityRows: DB["transcript_event_identities"][] = [];
  const activeRows: DB["session_transcript_active_events"][] = [];
  let eventCharacters = 0;
  const flushRows = () => {
    if (eventRows.length) {
      insertEvents.batch(eventRows);
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
