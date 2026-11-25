import type { TranscriptRecentReadLimits } from "../../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../../sessions/transcript-read-window.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readSessionTranscriptHistoryEventPageFromProjection } from "./session-accessor.sqlite-history-query.js";
import type { SessionTranscriptMessageEventPage } from "./session-accessor.sqlite-projection-read.js";

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: {
    maxMessages: number;
    offset: number;
    beforeSeq?: number;
    maxBytes?: number;
    allowOversizedFirst?: boolean;
    readOnly?: boolean;
    recentAtHead?: TranscriptRecentReadLimits;
  } & TranscriptReadWindowOptions,
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryEventPageFromProjection(projection, options),
    options,
  );
}
