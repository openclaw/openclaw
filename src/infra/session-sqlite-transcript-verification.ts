/** Shared read-only proof that retained transcript events exist in canonical SQLite. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withSqliteSessionImportStage } from "../config/sessions/session-accessor.sqlite-import-stage.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  createTranscriptEventReader,
  readTranscriptFingerprint,
} from "./session-sqlite-migration-readers.js";

export function verifyTranscriptEvents(
  database: DatabaseSync,
  source: { path: string; sessionId: string; originalPath: string },
  mode: "ordered" | "contained" | "appendable" = "ordered",
): { events: number; missingEvents: number; sqliteEvents: number } | undefined {
  return withSqliteSessionImportStage((stage) => {
    let seq = 0;
    const validate = createTranscriptEventReader(
      source.path,
      source.sessionId,
      false,
      readTranscriptFingerprint(source.path),
      source.originalPath,
    )((event) => stage.append(0, seq++, JSON.stringify(event)));
    if (mode === "ordered") {
      const repair = stage.repairLegacyTranscript(0);
      // Receipt adoption retains its original order and branch-repair contract.
      if (repair.repaired || !repair.recognized) {
        return undefined;
      }
    }
    const db = getSessionKysely(database);
    const sqliteEvents = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("transcript_events")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("session_id", "=", source.sessionId),
    )!.count;
    const sourceRows = stage.rows(0)[Symbol.iterator]();
    let expected = sourceRows.next();
    try {
      for (const event of iterateSqliteQuerySync(
        database,
        db
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(database).as("event_json"))
          .where("session_id", "=", source.sessionId)
          .orderBy("seq", "asc"),
      )) {
        if (mode !== "ordered") {
          stage.addSeen(event.event_json);
          const entry: unknown = JSON.parse(event.event_json);
          if (isRecord(entry) && typeof entry.id === "string") {
            stage.addSeen(`id\0${entry.id}`);
          }
        }
        if (!expected.done && event.event_json === expected.value.eventJson) {
          expected = sourceRows.next();
          if (expected.done) {
            break;
          }
        }
      }
    } finally {
      sourceRows.return?.();
    }
    if (mode === "ordered" || expected.done) {
      validate();
      return expected.done ? { events: seq, missingEvents: 0, sqliteEvents } : undefined;
    }
    let missingEvents = 0;
    let firstMissing: string | undefined;
    for (const row of stage.rows(0)) {
      const entry: unknown = JSON.parse(row.eventJson);
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : `row ${row.seq + 1}`;
      // Exact payloads include identity and parent links; physical SQLite order may differ.
      if (stage.contains(row.eventJson)) {
        if (firstMissing !== undefined) {
          throw new Error(
            `Missing legacy event ${firstMissing} precedes existing event ${id}; only a missing suffix can be appended`,
          );
        }
        continue;
      }
      if (mode !== "appendable") {
        return undefined;
      }
      if (stage.contains(`id\0${id}`)) {
        throw new Error(`Legacy event ${id} conflicts with the SQLite event of the same identity`);
      }
      firstMissing ??= id;
      missingEvents += 1;
    }
    if (missingEvents > 0) {
      const repair = stage.repairLegacyTranscript(0);
      // Missing history must be appendable without discarding or rewriting original rows.
      if (repair.repaired || !repair.recognized) {
        return undefined;
      }
    }
    validate();
    return { events: seq, missingEvents, sqliteEvents };
  });
}

/** Read-only content proof for Doctor's informational missing-index finding. */
export function verifyCanonicalSessionTranscriptSources(params: {
  target: { agentId: string; sqlitePath: string };
  sources: readonly { path: string; sessionId: string; originalPath?: string }[];
  env: NodeJS.ProcessEnv;
  mode?: "ordered" | "contained" | "appendable";
}): { entries: number; events: number; missingEvents: number; sqliteEvents: number } | undefined {
  const verified = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      let events = 0;
      let missingEvents = 0;
      let sqliteEvents = 0;
      for (const source of params.sources) {
        const verifiedSource = verifyTranscriptEvents(
          database.db,
          { ...source, originalPath: source.originalPath ?? source.path },
          params.mode,
        );
        if (!verifiedSource) {
          return undefined;
        }
        events += verifiedSource.events;
        missingEvents += verifiedSource.missingEvents;
        sqliteEvents += verifiedSource.sqliteEvents;
      }
      return { entries: params.sources.length, events, missingEvents, sqliteEvents };
    },
    { agentId: params.target.agentId, path: params.target.sqlitePath, env: params.env },
  );
  return verified.found ? verified.value : undefined;
}
