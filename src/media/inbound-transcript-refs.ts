import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { listExistingAgentDatabaseTargets } from "../commands/doctor-session-sqlite-readers.js";
import { getRuntimeConfig } from "../config/config.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { parseInboundMediaUri } from "./media-reference.js";

const INBOUND_MEDIA_URI_PATTERN = /media:\/\/inbound\/[^\s"'<>\\\]]+/gi;
const TRANSCRIPT_SCAN_WINDOW_ROWIDS = 200;

function tryParseInboundMediaId(source: string): string | undefined {
  try {
    return parseInboundMediaUri(source)?.id;
  } catch {
    return undefined;
  }
}

function collectRowReferences(
  eventJson: string,
  candidateIds: ReadonlySet<string>,
  referenced: Set<string>,
): void {
  for (const match of eventJson.matchAll(INBOUND_MEDIA_URI_PATTERN)) {
    const id = tryParseInboundMediaId(match[0]);
    if (id && candidateIds.has(id)) {
      referenced.add(id);
    }
  }
}

export async function collectTranscriptReferencedInboundMediaIds(
  candidateIds: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  if (candidateIds.size === 0) {
    return referenced;
  }
  try {
    for (const target of listExistingAgentDatabaseTargets(getRuntimeConfig(), process.env)) {
      const database = openNodeSqliteDatabase(target.sqlitePath, { readOnly: true });
      try {
        if (!tableExists(database, "transcript_events")) {
          continue;
        }
        const bounds = database
          .prepare("SELECT min(rowid) AS lo, max(rowid) AS hi FROM transcript_events")
          .get() as { lo?: unknown; hi?: unknown } | undefined;
        if (typeof bounds?.lo !== "number" || typeof bounds.hi !== "number") {
          continue;
        }
        const selectWindow = database.prepare(
          "SELECT event_json AS event_json FROM transcript_events WHERE rowid >= ? AND rowid <= ? AND instr(event_json, 'media://inbound/') > 0",
        );
        let cursor = bounds.lo;
        while (cursor <= bounds.hi) {
          const windowEnd = Math.min(cursor + TRANSCRIPT_SCAN_WINDOW_ROWIDS - 1, bounds.hi);
          const rows = selectWindow.all(cursor, windowEnd) as { event_json?: unknown }[];
          for (const row of rows) {
            if (typeof row.event_json === "string") {
              collectRowReferences(row.event_json, candidateIds, referenced);
            }
          }
          if (referenced.size === candidateIds.size) {
            break;
          }
          cursor = windowEnd + 1;
          if (cursor <= bounds.hi) {
            await yieldToEventLoop();
          }
        }
      } finally {
        database.close();
      }
      if (referenced.size === candidateIds.size) {
        break;
      }
    }
    return referenced;
  } catch {
    return null;
  }
}
