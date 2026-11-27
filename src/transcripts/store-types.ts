import type { TranscriptDisplayTurn } from "./speaker-labels.js";
import type { TranscriptSessionDescriptor, TranscriptsSummary } from "./types.js";

export type TranscriptReadEntry = {
  session: TranscriptSessionDescriptor;
  selector: string;
  hasSummary: boolean;
  utteranceCount: number;
  participants: string[];
  overview: string | undefined;
  summarySource: TranscriptsSummary["source"] | undefined;
  updatedAt: string;
  lastUtteranceAt: string | null;
};

export type TranscriptReadNotes = {
  summary?: Omit<TranscriptsSummary, "transcript">;
  markdown?: string;
};

export type TranscriptSummarySnapshot = {
  hasSpeakerAliases?: boolean;
  inputRevision: string;
  nextSequence: number;
  stoppedAt?: string;
  summaryRevision: string;
  turns: TranscriptDisplayTurn[];
  utteranceCount: number;
};

export type TranscriptSummaryWriteGuard = Pick<
  TranscriptSummarySnapshot,
  "inputRevision" | "nextSequence" | "summaryRevision"
> & { allowAppends: boolean };

export type TranscriptsSessionEntry = {
  session: TranscriptSessionDescriptor;
  sessionDir: string;
  selector: string;
  summaryPath: string;
  hasSummary: boolean;
};

export type TranscriptArtifactKind = "all" | "metadata" | "summary" | "transcript";

export type MaterializedTranscriptArtifacts = {
  sessionDir: string;
  metadataPath: string;
  transcriptPath: string;
  summaryPath: string;
  hasSummary: boolean;
};
