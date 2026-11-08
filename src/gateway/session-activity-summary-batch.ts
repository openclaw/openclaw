import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "../config/sessions/activity-summary-source.types.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";

type Batch = NonNullable<SessionActivitySummaryBatchResult>;

export const ACTIVITY_SUMMARY_MAX_BYTES = 128 * 1024;

/** The worker and complete actor replica apply the same incremental summary policy. */
export function selectActivitySummaryBatch(params: {
  previous: SessionActivitySummaryBatchInput["previous"];
  snapshot: Batch["snapshot"];
  watermark: Batch["watermark"];
  isOnActivePath: (entryId: string) => boolean;
  readPage: (
    start: number,
    count: number,
    includeEarlier?: boolean,
  ) => Batch["page"] & { hasOversizedMessages?: boolean };
}): Batch {
  const { snapshot, watermark } = params;
  let previous = params.previous;
  if (
    previous &&
    (previous.generation !== (snapshot.snapshot.generation ?? null) ||
      previous.coveredMessages > snapshot.totalMessages ||
      (previous.leafEntryId && !params.isOnActivePath(previous.leafEntryId)))
  ) {
    previous = undefined;
  }
  const covered = previous?.coveredMessages ?? 0;
  let batchSize = Math.min(64, snapshot.totalMessages - covered);
  const earlierOmission =
    previous?.omittedContent &&
    (previous.formatRevision === ACTIVITY_SUMMARY_FORMAT_REVISION ||
      params.readPage(covered, 0, true).hasOversizedMessages);
  let page = params.readPage(covered, batchSize);
  while (batchSize > 1 && page.events.length < page.scannedMessages) {
    batchSize = Math.max(1, Math.floor(batchSize / 2));
    page = params.readPage(covered, batchSize);
  }
  // Shrinking leaves only individually oversized omissions; recheck legacy flags by role.
  return {
    previous,
    snapshot,
    watermark,
    covered,
    page,
    omitted: earlierOmission === true || page.hasOversizedMessages === true,
  };
}
