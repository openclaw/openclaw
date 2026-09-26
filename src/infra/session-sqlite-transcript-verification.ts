/** Shared read-only proof that retained transcript events exist in canonical SQLite. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withSqliteSessionImportStage } from "../config/sessions/session-accessor.sqlite-import-stage.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  createTranscriptEventReader,
  readTranscriptFingerprint,
} from "./session-sqlite-migration-readers.js";

export function verifyTranscriptEvents(
  database: DatabaseSync,
  source: { path: string; sessionId: string; originalPath: string },
  allowMissingSuffix = false,
): { events: number; missingEvents: number } | undefined {
  return withSqliteSessionImportStage((stage) => {
    let seq = 0;
    const validate = createTranscriptEventReader(
      source.path,
      source.sessionId,
      false,
      readTranscriptFingerprint(source.path),
      source.originalPath,
    )((event) => stage.append(0, seq++, JSON.stringify(event)));
    const repair = stage.repairLegacyTranscript(0);
    // Old metadata cannot prove that a now-discarded branch was deliberately retired then.
    if (repair.repaired || !repair.recognized) {
      return undefined;
    }
    const db = getSessionKysely(database);
    const sourceRows = stage.rows(0)[Symbol.iterator]();
    try {
      let expected = sourceRows.next();
      for (const event of iterateSqliteQuerySync(
        database,
        db
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(database).as("event_json"))
          .where("session_id", "=", source.sessionId)
          .orderBy("seq", "asc"),
      )) {
        if (allowMissingSuffix) {
          stage.addSeen(event.event_json);
          const entry: unknown = JSON.parse(event.event_json);
          if (isRecord(entry) && typeof entry.id === "string") {
            stage.addSeen(`id\0${entry.id}`);
          }
        }
        if (expected.done) {
          break;
        }
        // Canonical history may contain newer events, but must preserve source order and repeats.
        if (event.event_json === expected.value.eventJson) {
          expected = sourceRows.next();
          if (expected.done) {
            break;
          }
        }
      }
      let missingEvents = 0;
      if (allowMissingSuffix) {
        while (!expected.done) {
          const entry: unknown = JSON.parse(expected.value.eventJson);
          // Append-only import cannot insert a missing middle row or replace an existing ID.
          if (
            stage.contains(expected.value.eventJson) ||
            (isRecord(entry) && typeof entry.id === "string" && stage.contains(`id\0${entry.id}`))
          ) {
            return undefined;
          }
          missingEvents += 1;
          expected = sourceRows.next();
        }
      }
      validate();
      return expected.done ? { events: seq, missingEvents } : undefined;
    } finally {
      sourceRows.return?.();
    }
  });
}

/** Read-only content proof for Doctor's informational missing-index finding. */
export function verifyCanonicalSessionTranscriptSources(params: {
  target: { agentId: string; sqlitePath: string };
  sources: readonly { path: string; sessionId: string; originalPath?: string }[];
  env: NodeJS.ProcessEnv;
  allowMissingSuffix?: boolean;
}): { entries: number; events: number; missingEvents: number } | undefined {
  const verified = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      let events = 0;
      let missingEvents = 0;
      for (const source of params.sources) {
        const verifiedSource = verifyTranscriptEvents(
          database.db,
          { ...source, originalPath: source.originalPath ?? source.path },
          params.allowMissingSuffix,
        );
        if (!verifiedSource) {
          return undefined;
        }
        events += verifiedSource.events;
        missingEvents += verifiedSource.missingEvents;
      }
      return { entries: params.sources.length, events, missingEvents };
    },
    { agentId: params.target.agentId, path: params.target.sqlitePath, env: params.env },
  );
  return verified.found ? verified.value : undefined;
}
