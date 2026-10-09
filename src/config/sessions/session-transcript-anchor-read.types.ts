import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionTranscriptAnchorFacts = {
  anchors: TranscriptEntryAnchor[];
  session?: { sessionId: string; lifecycleRevision?: string };
  header?: unknown;
  watermark?: SessionTranscriptWatermark;
  contextValidated?: true;
  contextAuthority?: {
    entry?: Pick<
      InternalSessionEntry,
      | "sessionId"
      | "lifecycleRevision"
      | "activeWriterRunId"
      | "cliHistoryBoundary"
      | "permissionMode"
    >;
    watermark: SessionTranscriptWatermark;
  };
  replayValidated?: "current" | "initial";
  tail?: {
    lastSeq?: number;
    entries: {
      entryId: string;
      role: "user" | "assistant";
      runId?: string;
      anchor?: TranscriptEntryAnchor;
    }[];
  };
};
