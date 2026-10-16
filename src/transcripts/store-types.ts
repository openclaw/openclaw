import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import type { TranscriptsSummary } from "./summary.js";

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
  inputRevision: string;
  nextSequence: number;
  stoppedAt?: string;
  summaryRevision: string;
  utterances: TranscriptUtterance[];
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
  summaryJsonPath: string;
  summaryPath: string;
  hasSummary: boolean;
};
