import type { SessionActivitySummaryBatchInput } from "../config/sessions/activity-summary-source.types.js";
import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "../config/sessions/session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { readActivePathEntryRelationFromProjection } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import {
  ACTIVITY_SUMMARY_MAX_BYTES,
  selectActivitySummaryBatch,
} from "./session-activity-summary-batch.js";

/** Only byte-bounded bodies leave the transcript worker. */
export function readActivitySummaryBatch(params: SessionActivitySummaryBatchInput) {
  return withCurrentProjectionSnapshot(
    params.scope,
    (projection) => {
      const snapshot = readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
        maxBytes: 0,
        maxMessages: 0,
        offset: 0,
      });
      return selectActivitySummaryBatch({
        previous: params.previous,
        snapshot,
        watermark: {
          generation: projection.version.generation,
          maxSeq: projection.version.rawSeq,
        },
        isOnActivePath: (entryId) =>
          readActivePathEntryRelationFromProjection(projection, entryId) !== "off-path",
        readPage: (start, count, includeEarlier = false) =>
          readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
            maxBytes: ACTIVITY_SUMMARY_MAX_BYTES,
            maxMessages: count,
            offset: snapshot.totalMessages - start - count,
            oversizedMessageCheck: { roles: ["user", "assistant"], includeEarlier },
          }),
      });
    },
    { readOnly: true },
  );
}
