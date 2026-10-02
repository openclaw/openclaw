import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  createTranscriptDisplayPositionFromActivity,
  createTranscriptDisplaySource,
} from "../../sessions/transcript-display-position.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { iterateUnindexedTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export function readTranscriptDisplaySource(
  projection: CurrentTranscriptProjection,
): string | undefined {
  const generation = projection.generation;
  return generation
    ? createTranscriptDisplaySource([
        "sqlite",
        projection.database.path,
        projection.resolved.agentId,
        projection.resolved.sessionId,
        generation,
      ])
    : undefined;
}

/** Enrich only selected rows, in their existing snapshot; anchor lookups never load payloads. */
export function positionTranscriptDisplayEvents<
  T extends { event: TranscriptEvent; eventSeq: number },
>(
  projection: CurrentTranscriptProjection,
  source: string | undefined,
  events: T[],
): Array<T & { displayPosition?: TranscriptDisplayPosition }> {
  if (!source || events.length === 0) {
    return events;
  }
  const activities = events.map(
    ({ event }) => readNestedToolActivity(asOptionalRecord(event)?.message)?.details,
  );
  const anchors = [...new Set(activities.flatMap((activity) => activity?.afterEntryId ?? []))];
  const sequences = new Map<string, number>();
  const beforeRawSeq = resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  })?.beforeRawSeq;
  const maxSeq = Math.min(
    projection.state.indexedSeq,
    beforeRawSeq === undefined ? Infinity : beforeRawSeq - 1,
  );
  if (anchors.length > 0) {
    const rows = executeSqliteQuerySync(
      projection.database.db,
      getActiveTranscriptKysely(projection.database)
        .selectFrom("transcript_event_identities")
        .select(["event_id", "seq"])
        .where("session_id", "=", projection.resolved.sessionId)
        .where("event_id", "in", sqliteStringSet(anchors))
        .where("seq", "<=", maxSeq),
    ).rows;
    for (const row of rows) {
      sequences.set(row.event_id, row.seq);
    }
  }
  if (projection.hasUnindexedPrefix) {
    const missing = new Set(anchors.filter((id) => !sequences.has(id)));
    if (missing.size > 0) {
      for (const row of iterateUnindexedTranscriptNavigation(projection, {
        eventIds: [...missing],
        maxRawSeq: maxSeq,
      })) {
        const id = typeof row.event.id === "string" ? row.event.id.trim() : undefined;
        if (id !== undefined && missing.has(id)) {
          sequences.set(id, row.event_seq);
        }
      }
    }
  }
  return events.map((row, index) => ({
    ...row,
    displayPosition: createTranscriptDisplayPositionFromActivity(
      source,
      row.eventSeq,
      activities[index],
      (id) => sequences.get(id),
    ),
  }));
}
