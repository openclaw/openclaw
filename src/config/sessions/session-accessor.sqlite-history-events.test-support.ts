import type { TranscriptRecentReadLimits } from "../../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../../sessions/transcript-read-window.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptDisplayDeltaFromProjection,
  readRecentSessionTranscriptHistoryEventsFromProjection,
  type SessionTranscriptDisplayDeltaResult,
} from "./session-accessor.sqlite-history-query.js";
import type { SessionTranscriptMessageEventPage } from "./session-accessor.sqlite-projection-read.js";

// Exercise the worker's projection queries inside an owned SQLite snapshot.
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
