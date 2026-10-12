import { withRecentSessionTranscriptActiveEventsInSnapshot } from "./session-accessor.sqlite-active-events-read.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "./session-accessor.sqlite-reset-window.js";
import { readSessionTranscriptAccountingTail } from "./session-transcript-accounting-policy.js";
import {
  SQLITE_USAGE_TAIL_MAX_EVENTS,
  type SessionTranscriptAccountingOptions,
  type SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";

export function readSessionTranscriptAccountingFromProjection(
  projection: CurrentTranscriptProjection,
  params: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot {
  const snapshot: SessionTranscriptAccountingSnapshot = {};
  try {
    if (params.includeByteSize) {
      const stats = readVisibleTranscriptStats(projection);
      snapshot.byteSize = stats.sizeBytes;
      snapshot.eventCount = stats.eventCount;
    }
    if (params.includeUsage || params.includeTurnTaint) {
      Object.assign(
        snapshot,
        withRecentSessionTranscriptActiveEventsInSnapshot(
          projection,
          params.usageEventLimit ?? SQLITE_USAGE_TAIL_MAX_EVENTS,
          (visit) => readSessionTranscriptAccountingTail(visit, params),
        ),
      );
    }
  } catch {
    if (params.includeTurnTaint) {
      snapshot.turnTainted = true;
    }
  }
  return snapshot;
}
