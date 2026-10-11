import type { SessionEntrySummary } from "./session-accessor.types.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";

/** Exact database facts shared by durable row readers and the incognito actor. */
export type SessionRowDatabaseFacts = SessionEntrySummary & {
  hasBoard: boolean;
  activitySummaryWatermark?: SessionTranscriptWatermark;
};
