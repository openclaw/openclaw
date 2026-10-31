/** Read-only transcript detection; positive repairs retain exact snapshots. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteTranscriptStorageRow } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  readTranscriptPayload,
  transcriptEventJsonSql,
} from "../config/sessions/transcript-payload.js";
import { iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";

type ReadOnlyTranscriptSnapshot =
  | {
      ok: true;
      rows: Array<{ eventJson: string; seq: number }>;
    }
  | { ok: false; error: unknown };

function resetReadIterator(iterator: ReturnType<StatementSync["iterate"]> | undefined): void {
  // A throwing next() does not close its iterator; reset before the next session.
  try {
    iterator?.return?.();
  } catch {
    // Preserve the original read error if cleanup fails.
  }
}

export class ReadOnlySqliteTranscriptReader {
  private labelDetection?: StatementSync;
  private labelCandidate?: StatementSync;
  private labelSnapshot?: StatementSync;
  private headerSnapshot?: StatementSync;
  private sessionKey?: StatementSync;
  private readonly compressed: boolean;
  private readonly eventJsonSql: string;
  private readonly labelRowsSql: string;
  private readonly labelDetectionSql: string;

  // Statements belong to one read-only pass, but no cursor survives a snapshot call.
  // Prepare lazily so older databases need only the schema used by that detection path.
  constructor(private readonly database: DatabaseSync) {
    // Doctor also inspects databases before their storage migration runs.
    this.compressed = tableHasColumn(database, "transcript_events", "event_zstd");
    this.eventJsonSql = this.compressed
      ? transcriptEventJsonSql(database).compile(getSessionKysely(database)).sql
      : "event_json";
    this.labelRowsSql = `SELECT ${this.eventJsonSql} AS event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC`;
    this.labelDetectionSql = this.compressed
      ? "SELECT event_json, navigation_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC"
      : this.labelRowsSql;
  }

  sessionIds(): string[] {
    if (!tableExists(this.database, "transcript_events")) {
      return [];
    }
    // Enumerate the schema-stable events table, not post-ship sessions columns.
    // Materialize IDs so enumeration cannot hold a read transaction across repairs.
    // Cold archives own their payloads; retained navigation is outside these repairs.
    const hotOnly = tableExists(this.database, "session_transcript_cold_archives")
      ? " WHERE session_id NOT IN (SELECT session_id FROM session_transcript_cold_archives)"
      : "";
    const rows = this.database
      .prepare(
        `SELECT DISTINCT session_id FROM transcript_events${hotOnly} ORDER BY session_id ASC`,
      )
      .all();
    return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
  }

  /** Decode one first row per session, closing enumeration before any repair opens a writer. */
  headerlessSessionIds(reportError: (sessionId: string, error: unknown) => void): string[] {
    if (!tableExists(this.database, "transcript_events")) {
      return [];
    }
    const db = getSessionKysely(this.database);
    const firstRows = db
      .selectFrom("transcript_events")
      .$if(tableExists(this.database, "session_transcript_cold_archives"), (query) =>
        query.where("session_id", "not in", (eb) =>
          eb.selectFrom("session_transcript_cold_archives").select("session_id"),
        ),
      )
      .select("session_id")
      .select((eb) => eb.fn.min<number>("seq").as("seq"))
      .groupBy("session_id")
      .as("first");
    const firstEvents = db
      .selectFrom("transcript_events as event")
      .innerJoin(firstRows, (join) =>
        join
          .onRef("event.session_id", "=", "first.session_id")
          .onRef("event.seq", "=", "first.seq"),
      )
      .select(["event.session_id", "event.event_json"]);
    const query = this.compressed
      ? firstEvents.select(["event.event_zstd", "event.event_utf8_bytes"])
      : firstEvents.select((eb) => [
          eb.val(null).as("event_zstd"),
          eb.val(null).as("event_utf8_bytes"),
        ]);
    const candidates: string[] = [];
    for (const row of iterateSqliteQuerySync(this.database, query)) {
      if (typeof row.session_id !== "string") {
        continue;
      }
      let eventJson: unknown;
      try {
        // Native SQL decoding would let one corrupt payload abort the entire database scan.
        eventJson = this.compressed ? readTranscriptPayload(row) : row.event_json;
      } catch (error) {
        reportError(row.session_id, error);
        continue;
      }
      if (typeof eventJson !== "string") {
        // Let the exact snapshot report legacy non-TEXT row metadata.
        candidates.push(row.session_id);
        continue;
      }
      let first: unknown;
      try {
        first = JSON.parse(eventJson);
      } catch {
        continue;
      }
      if (isRecord(first) && first.type !== "session") {
        candidates.push(row.session_id);
      }
    }
    return candidates.toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  }

  labelRepairSnapshot(
    sessionId: string,
    needsRepair: (event: unknown) => boolean,
    mayNeedRepair: (eventJson: string) => boolean,
  ): ReadOnlyTranscriptSnapshot {
    let iterator: ReturnType<StatementSync["iterate"]> | undefined;
    try {
      // Unchanged histories retain one payload. Re-read positive candidates in full so
      // malformed siblings and exact-snapshot guards still govern the surgical repair.
      this.labelDetection ??= this.database.prepare(this.labelDetectionSql);
      iterator = this.labelDetection.iterate(sessionId);
      for (const row of iterator) {
        if (typeof row.seq !== "number") {
          continue;
        }
        let eventJson = row.event_json;
        if (typeof eventJson !== "string") {
          if (typeof row.navigation_json === "string") {
            // The stored projection preserves duplicate keys; SQL role columns use first-key semantics.
            const { navigation }: { navigation: unknown } = JSON.parse(row.navigation_json);
            if (
              !isRecord(navigation) ||
              navigation.type !== "message" ||
              !isRecord(navigation.message) ||
              (navigation.message.role !== "user" && navigation.message.role !== "assistant")
            ) {
              continue;
            }
          }
          this.labelCandidate ??= this.database.prepare(
            `SELECT ${this.eventJsonSql} AS event_json FROM transcript_events WHERE session_id = ? AND seq = ?`,
          );
          eventJson = this.labelCandidate.get(sessionId, row.seq)?.event_json ?? null;
        }
        if (typeof eventJson !== "string" || !mayNeedRepair(eventJson)) {
          continue;
        }
        let event: unknown;
        try {
          event = JSON.parse(eventJson);
        } catch {
          continue;
        }
        if (!needsRepair(event)) {
          continue;
        }
        const rows: Array<{ eventJson: string; seq: number }> = [];
        // Detection is still iterating: its nested exact snapshot needs a distinct statement.
        this.labelSnapshot ??= this.database.prepare(this.labelRowsSql);
        iterator = this.labelSnapshot.iterate(sessionId);
        for (const candidate of iterator) {
          if (typeof candidate.event_json === "string" && typeof candidate.seq === "number") {
            rows.push({ eventJson: candidate.event_json, seq: candidate.seq });
          }
        }
        return { ok: true, rows };
      }
      return { ok: true, rows: [] };
    } catch (error) {
      resetReadIterator(iterator);
      return { ok: false, error };
    }
  }

  /** Reads exact row metadata for a guarded transcript replacement without opening a writer. */
  headerlessSnapshot(
    sessionId: string,
    acceptRow: (row: SqliteTranscriptStorageRow) => boolean,
  ):
    | { ok: true; rows: SqliteTranscriptStorageRow[]; sessionKey?: string }
    | { ok: false; error: unknown } {
    let iterator: ReturnType<StatementSync["iterate"]> | undefined;
    try {
      this.sessionKey ??= this.database.prepare(
        "SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1",
      );
      const sessionKeyRow = this.sessionKey.get(sessionId);
      const storageRows: SqliteTranscriptStorageRow[] = [];
      this.headerSnapshot ??= this.database.prepare(
        `SELECT created_at, ${this.eventJsonSql} AS event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC`,
      );
      iterator = this.headerSnapshot.iterate(sessionId);
      for (const row of iterator) {
        if (
          typeof row.created_at !== "number" ||
          typeof row.event_json !== "string" ||
          typeof row.seq !== "number"
        ) {
          return {
            ok: false,
            error: new Error(`Invalid transcript row metadata for session ${sessionId}`),
          };
        }
        const storageRow = {
          createdAt: row.created_at,
          eventJson: row.event_json,
          seq: row.seq,
        };
        // Reject an ineligible prefix before retaining the rest of a large history.
        // Positive repairs still carry every exact row into writer revalidation.
        if (!acceptRow(storageRow)) {
          return { ok: true, rows: [] };
        }
        storageRows.push(storageRow);
      }
      return {
        ok: true,
        rows: storageRows,
        ...(typeof sessionKeyRow?.session_key === "string"
          ? { sessionKey: sessionKeyRow.session_key }
          : {}),
      };
    } catch (error) {
      resetReadIterator(iterator);
      return { ok: false, error };
    }
  }
}
