import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { jsonArrayElements } from "../../infra/database-engine/json-values.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  SessionTranscriptBoundedActiveContext,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { iterateUnindexedActiveTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import {
  selectActiveTranscriptIdentityRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";

export function transcriptPositionSet(
  projection: CurrentTranscriptProjection,
  positions: number[],
) {
  // A complete current context can exceed SQLite's bound-parameter limit.
  return /* kysely-allow-raw: Numeric position sets use one binding on both database engines. */ sql<number>`(SELECT CAST(value AS BIGINT) FROM ${jsonArrayElements(projection.database.db, sql.val(JSON.stringify(positions)))})`;
}

export function readBoundedRetentionRanges(
  projection: CurrentTranscriptProjection,
  rows: Array<{ event: TranscriptEvent; seq: number }>,
  headerOffset: number,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const sequences = new Map<string, number>();
  const cuts = rows.flatMap(({ event, seq }, endIndex) => {
    const entry = asOptionalRecord(event);
    if (typeof entry?.id !== "string") {
      return [];
    }
    if (!projection.hasUnindexedPrefix || !sequences.has(entry.id)) {
      sequences.set(entry.id, seq);
    }
    return (entry.type === "compaction" || entry.type === "reset") &&
      typeof entry.firstKeptEntryId === "string"
      ? [{ id: entry.id, firstKeptEntryId: entry.firstKeptEntryId, endIndex, seq }]
      : [];
  });
  const missing = [...new Set(cuts.map((cut) => cut.firstKeptEntryId))].filter(
    (id) => !sequences.has(id),
  );
  if (missing.length > 0) {
    const lastSelectedSeq = rows.reduce((maximum, row) => Math.max(maximum, row.seq), -Infinity);
    const anchors = executeSqliteQuerySync(
      projection.database.db,
      selectActiveTranscriptIdentityRows(projection.database)
        .select(["identity.event_id", "identity.seq"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "in", missing)
        .where("identity.seq", "<=", lastSelectedSeq),
    ).rows;
    for (const anchor of anchors) {
      sequences.set(anchor.event_id, anchor.seq);
    }
  }
  if (projection.hasUnindexedPrefix && cuts.length > 0) {
    // Imported duplicates can precede an indexed owner or the selected byte window.
    const unresolved = new Set(cuts.map((cut) => cut.firstKeptEntryId));
    for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
      eventIds: [...unresolved],
      maxRawSeq: cuts.reduce((maximum, cut) => Math.max(maximum, cut.seq), -Infinity) - 1,
      first: true,
    })) {
      const id = typeof row.event.id === "string" ? row.event.id : undefined;
      if (id === undefined || !unresolved.delete(id)) {
        continue;
      }
      const selectedSeq = sequences.get(id);
      if (selectedSeq === undefined || row.event_seq < selectedSeq) {
        sequences.set(id, row.event_seq);
      }
      if (unresolved.size === 0) {
        break;
      }
    }
  }
  const ranges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  for (const cut of cuts) {
    const firstSeq = sequences.get(cut.firstKeptEntryId);
    if (firstSeq === undefined || (projection.hasUnindexedPrefix && firstSeq >= cut.seq)) {
      continue;
    }
    // An injected boundary can precede the sorted rows, so honor its first-match position.
    let start = cut.endIndex > 0 && rows[0]!.seq >= firstSeq ? 0 : Math.min(1, cut.endIndex);
    let end = start === 0 ? 0 : cut.endIndex;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (rows[middle]!.seq < firstSeq) {
        start = middle + 1;
      } else {
        end = middle;
      }
    }
    ranges.set(cut.id, {
      startIndex: start + headerOffset,
      endIndex: cut.endIndex + headerOffset,
    });
  }
  return ranges;
}
