import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionTranscriptAnchorEntry = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "cliHistoryBoundary" | "permissionMode"
>;

export type SessionTranscriptAnchorFacts = {
  anchors: TranscriptEntryAnchor[];
  activePathRelation?: "exact" | "ancestor" | "off-path";
  session?: { sessionId: string; lifecycleRevision?: string };
  header?: unknown;
  watermark?: SessionTranscriptWatermark;
  messagePresence?: boolean;
  metadata?: { present: boolean; observedAt: number | null; updatedAt: number | null };
  contextValidated?: true;
  contextAuthority?: {
    entry?: SessionTranscriptAnchorEntry;
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
      message?: unknown;
    }[];
  };
};
