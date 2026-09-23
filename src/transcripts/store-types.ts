import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";

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
