import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "../config/sessions/session-cold-storage-read.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { iterateSqliteQuerySync } from "./kysely-sync.js";
import { parseUsageCostTranscriptRecord } from "./session-cost-usage-pricing.js";
import type { ParsedTranscriptEntry } from "./session-cost-usage.types.js";

// This projection never leaves the refresh worker or replaces canonical transcript bytes.
const usageEntry = Symbol("usage-cost-entry");
type UsageRecord = Record<string, unknown> & { [usageEntry]: ParsedTranscriptEntry | null };

/** Retain branch navigation and accounting facts, not message/tool payloads. */
export function projectUsageCostWorkerRecord(event: unknown): unknown {
  if (!isRecord(event)) {
    return undefined;
  }
  const parsed = parseUsageCostTranscriptRecord(event);
  const record: UsageRecord = {
    [usageEntry]: parsed ? { ...parsed, message: {} } : null,
  };
  for (const key of ["type", "id", "parentId", "targetId", "appendParentId", "appendMode"]) {
    if (Object.hasOwn(event, key)) {
      record[key] = event[key];
    }
  }
  return record;
}

export function readUsageCostWorkerRecord(record: Record<string, unknown>) {
  if (usageEntry in record) {
    // SAFETY: Only this module's projector writes the private symbol and its parsed accounting value.
    return (record as UsageRecord)[usageEntry];
  }
  return parseUsageCostTranscriptRecord(record);
}

/** Consume the native iterator before releasing the caller's admitted read snapshot. */
export function readUsageCostSqliteRows(
  database: { db: DatabaseSync },
  sessionId: string,
  afterSeq: number,
  throughSeq: number,
  projectUsage: boolean,
) {
  return readHotSessionTranscriptSnapshot(database, sessionId, "incremental", () => {
    const query = getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventJsonSql(database.db).as("event_json")])
      .where("session_id", "=", sessionId)
      .where("seq", ">", afterSeq)
      .where("seq", "<=", throughSeq)
      .orderBy("seq", "asc");
    const events: Array<{ seq: number; event: unknown }> = [];
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      const event: unknown = JSON.parse(row.event_json);
      events.push({
        seq: row.seq,
        event: projectUsage ? projectUsageCostWorkerRecord(event) : event,
      });
    }
    return events;
  });
}
