/** Shared read-only proof that retained transcript events exist in canonical SQLite. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLegacyOpenAICodexTranscriptMetadata } from "../config/sessions/legacy-transcript-repair.js";
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

type StagedEventRows = {
  contains(eventJson: string): boolean;
  rows(source: number): Iterable<{ seq: number; eventJson: string }>;
};

type LegacyRetryScan = {
  conflicts: string[];
  missing: string[];
  /** First refusal in file order. A later row must not hide an earlier one. */
  firstRefusal?:
    | { kind: "conflict"; id: string }
    | { kind: "prefix"; missing: string; existing: string };
};

function legacyEventId(eventJson: string, seq: number): string {
  const entry: unknown = JSON.parse(eventJson);
  return isRecord(entry) && typeof entry.id === "string" ? entry.id : `row ${seq + 1}`;
}

/**
 * Provider and api spelling the importer rewrites before insert.
 * Rows that do not change keep their original bytes, so an unrelated field still conflicts.
 */
function legacyImportComparisonJson(eventJson: string): string {
  const parsed: unknown = JSON.parse(eventJson);
  if (!isRecord(parsed)) {
    return eventJson;
  }
  if (normalizeLegacyOpenAICodexTranscriptMetadata([parsed]) === 0) {
    return eventJson;
  }
  return JSON.stringify(parsed);
}

function samePersistedLegacyEvent(storedJson: string, sourceJson: string): boolean {
  if (storedJson === sourceJson) {
    return true;
  }
  return legacyImportComparisonJson(storedJson) === legacyImportComparisonJson(sourceJson);
}

function legacyRowIsStored(stage: StagedEventRows, eventJson: string): boolean {
  if (stage.contains(eventJson)) {
    return true;
  }
  const comparison = legacyImportComparisonJson(eventJson);
  return comparison !== eventJson && stage.contains(comparison);
}

function scanLegacyRetryRows(stage: StagedEventRows): LegacyRetryScan {
  const scan: LegacyRetryScan = { conflicts: [], missing: [] };
  let firstMissing: string | undefined;
  for (const row of stage.rows(0)) {
    const id = legacyEventId(row.eventJson, row.seq);
    if (legacyRowIsStored(stage, row.eventJson)) {
      if (firstMissing !== undefined && scan.firstRefusal === undefined) {
        scan.firstRefusal = { kind: "prefix", missing: firstMissing, existing: id };
      }
      continue;
    }
    // Same identity with a different payload is not a row that can be appended.
    if (stage.contains(`id\0${id}`)) {
      scan.conflicts.push(id);
      if (scan.firstRefusal === undefined) {
        scan.firstRefusal = { kind: "conflict", id };
      }
      continue;
    }
    firstMissing ??= id;
    scan.missing.push(id);
  }
  return scan;
}

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
    )((event) => stage.append(0, seq++, JSON.stringify(canonicalizeTranscriptEventMedia(event))));
    const repair = stage.repairLegacyTranscript(0, mode !== "ordered");
    if (mode === "ordered") {
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
        if (!expected.done) {
          // Ordered receipts stay byte-identical. Spelling equivalence is only for a retry.
          const sameEvent =
            mode === "ordered"
              ? event.event_json === expected.value.eventJson
              : samePersistedLegacyEvent(event.event_json, expected.value.eventJson);
          if (sameEvent) {
            expected = sourceRows.next();
            if (expected.done) {
              break;
            }
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
    const unresolved = scanLegacyRetryRows(stage);
    if (unresolved.conflicts.length === 0 && unresolved.missing.length === 0) {
      validate();
      return { events: repair.events, missingEvents: 0, sqliteEvents };
    }
    // Header-only repair kept message bytes. Re-run the importer's full repair
    // before refusing: a stored parent link or a dropped legacy row is not a second copy.
    const branchRepair = stage.repairLegacyTranscript(0);
    const repaired = scanLegacyRetryRows(stage);
    if (
      repaired.conflicts.length === 0 &&
      repaired.missing.length === 0 &&
      branchRepair.recognized
    ) {
      validate();
      return { events: branchRepair.events, missingEvents: 0, sqliteEvents };
    }
    if (mode !== "appendable") {
      return undefined;
    }
    if (repaired.firstRefusal?.kind === "prefix") {
      throw new Error(
        `Missing legacy event ${repaired.firstRefusal.missing} precedes existing event ${repaired.firstRefusal.existing}; only a missing suffix can be appended`,
      );
    }
    if (repaired.firstRefusal?.kind === "conflict" || !branchRepair.recognized) {
      const id =
        repaired.firstRefusal?.kind === "conflict"
          ? repaired.firstRefusal.id
          : unresolved.firstRefusal?.kind === "conflict"
            ? unresolved.firstRefusal.id
            : undefined;
      if (id) {
        throw new Error(`Legacy event ${id} conflicts with the SQLite event of the same identity`);
      }
      return undefined;
    }
    // A missing suffix may be appended only when that repair did not rewrite history.
    if (repaired.missing.length > 0 && branchRepair.repaired) {
      return undefined;
    }
    validate();
    return {
      events: branchRepair.events,
      missingEvents: repaired.missing.length,
      sqliteEvents,
    };
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
