import type { TranscriptRecentReadLimits } from "../../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../../sessions/transcript-read-window.js";
import type { SessionTranscriptMessageEventPage } from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryEventCount } from "./session-accessor.sqlite-history-projection.js";
import {
  readTranscriptDisplayDeltaFromProjection,
  readRecentSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryEventPageFromProjection,
  type SessionTranscriptDisplayDeltaResult,
} from "./session-accessor.sqlite-history-query.js";

export function readTranscriptDisplayDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptDisplayDeltaResult {
  const readLimits = { ...limits };
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readTranscriptDisplayDeltaFromProjection(projection, readLimits),
  );
}

export function readRecentSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: TranscriptRecentReadLimits & TranscriptReadWindowOptions & { readOnly?: boolean },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readRecentSessionTranscriptHistoryEventsFromProjection(projection, options),
    options,
  );
}

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: {
    maxMessages: number;
    offset: number;
    beforeSeq?: number;
    maxBytes?: number;
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

export function readSessionTranscriptHistoryEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(scope, resolveVisibleHistoryEventCount);
}
