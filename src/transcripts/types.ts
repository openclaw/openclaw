import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  TranscriptsGetResult,
  TranscriptSessionSummary,
  TranscriptUtterance as TranscriptUtteranceWire,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";

/** Supported source families for transcript providers. */
export type TranscriptSourceKind = NonNullable<TranscriptSessionSummary["source"]["kind"]>;

/** Provider-specific locator for a live, recorded, or imported transcript source. */
export type TranscriptSourceLocator = SchemaContract<TranscriptSessionSummary["source"]> & {
  [key: string]: string | undefined;
};

/** Speaker/participant identity attached to an utterance. */
export type TranscriptParticipant = {
  id?: string;
  label: string;
};

/** One captured or imported transcript utterance. */
export type TranscriptUtterance = SchemaContract<
  Omit<TranscriptUtteranceWire, "sequence" | "speakerId" | "speakerLabel">
> & {
  sessionId?: string;
  speaker?: TranscriptParticipant;
  metadata?: Record<string, unknown>;
};

/** Durable transcript session metadata. */
export type TranscriptSessionDescriptor = SchemaContract<
  Pick<TranscriptSessionSummary, "sessionId" | "title" | "startedAt" | "stoppedAt">
> & {
  source: TranscriptSourceLocator;
  metadata?: Record<string, unknown>;
};

type TranscriptSummaryWire = NonNullable<TranscriptsGetResult["summary"]>;

export type TranscriptsSummary = SchemaContract<
  Omit<TranscriptSummaryWire, "markdown" | "source">
> & {
  sessionId: string;
  title: string;
  source: NonNullable<TranscriptSummaryWire["source"]>;
  transcript: string[];
};
