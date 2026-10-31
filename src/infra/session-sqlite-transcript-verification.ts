import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLegacyInboundContextLabelsJson } from "../config/sessions/legacy-inbound-context-labels.js";
import { withSqliteSessionImportStage } from "../config/sessions/session-accessor.sqlite-import-stage.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { canonicalizeTranscriptEventMedia } from "../config/sessions/transcript-event-media.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { executeSqliteQueryTakeFirstSync, iterateSqliteQuerySync } from "./kysely-sync.js";
import {
  createTranscriptEventReader,
  readTranscriptFingerprint,
} from "./session-sqlite-migration-readers.js";
/** Shared read-only proof that retained transcript events exist in canonical SQLite. */
import type { EngineConnection } from "./sql-connection.js";

export function verifyTranscriptEvents(
  database: EngineConnection,
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
    )((event) =>
      stage.append(
        0,
        seq++,
        normalizeLegacyInboundContextLabelsJson(
          JSON.stringify(canonicalizeTranscriptEventMedia(event)),
        ),
      ),
    );
    const repair = stage.repairLegacyTranscript(0);
    // Ordered checks retain the historical provider/branch contract after label normalization.
    if (
      (mode === "ordered" && (repair.repaired || !repair.recognized)) ||
      (repair.branchRepaired && !repair.recognized)
    ) {
      return undefined;
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
        const eventJson = normalizeLegacyInboundContextLabelsJson(event.event_json);
        if (mode !== "ordered") {
          const entry = stage.addSeen(eventJson, true);
          if (isRecord(entry) && typeof entry.id === "string") {
            stage.addSeen(`id\0${entry.id}`);
          }
        }
        if (!expected.done && eventJson === expected.value.eventJson) {
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
      return expected.done ? { events: repair.events, missingEvents: 0, sqliteEvents } : undefined;
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
    // Appending must not require reconstruction or discard unrecognized history.
    if (missingEvents > 0 && (repair.branchRepaired || !repair.recognized)) {
      return undefined;
    }
    validate();
    return { events: repair.events, missingEvents, sqliteEvents };
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
