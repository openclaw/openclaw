import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { TranscriptSessionDescriptor, TranscriptSourceLocator } from "./provider-types.js";
import type {
  readLatestTranscriptEntry,
  readStoredTranscriptNotes,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
  TranscriptLibraryError,
  TranscriptReadPurpose,
} from "./store-read.js";
import type {
  readTranscriptSessionByIdentity,
  readTranscriptSessionEntries,
  readTranscriptSessionMatches,
  readStoredTranscriptSummary,
  readTranscriptUtterances,
} from "./store-sqlite-read.js";
import type {
  readRecentStoppedTranscriptSession,
  readTranscriptSummaryInputRevision,
} from "./store-sqlite.js";

type SessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;

export type TranscriptReadRequests = {
  "transcripts.sessionEntries": {
    input: undefined;
    output: ReturnType<typeof readTranscriptSessionEntries>;
  };
  "transcripts.matches": {
    input: { value: string };
    output: ReturnType<typeof readTranscriptSessionMatches>;
  };
  "transcripts.session": {
    input: { session: SessionIdentity };
    output: ReturnType<typeof readTranscriptSessionByIdentity>;
  };
  "transcripts.entry": {
    input: { selector: string; purpose: TranscriptReadPurpose };
    output: ReturnType<typeof readTranscriptEntry>;
  };
  "transcripts.latest": { input: undefined; output: ReturnType<typeof readLatestTranscriptEntry> };
  "transcripts.notes": {
    input: { session: SessionIdentity; purpose: TranscriptReadPurpose };
    output: ReturnType<typeof readStoredTranscriptNotes>;
  };
  "transcripts.libraryEntry": {
    input: Parameters<typeof readTranscriptLibraryEntry>[1];
    output: ReturnType<typeof readTranscriptLibraryEntry>;
  };
  "transcripts.recentStopped": {
    input: { source: TranscriptSourceLocator; stoppedAfter: string; stoppedBefore: string };
    output: ReturnType<typeof readRecentStoppedTranscriptSession>;
  };
  "transcripts.summaryRevision": {
    input: { session: SessionIdentity };
    output: ReturnType<typeof readTranscriptSummaryInputRevision>;
  };
  "transcripts.utterances": {
    input: { session: SessionIdentity; maxUtterances?: number };
    output: ReturnType<typeof readTranscriptUtterances>;
  };
  "transcripts.summary": {
    input: { session: SessionIdentity };
    output: ReturnType<typeof readStoredTranscriptSummary>;
  };
};

type TranscriptReadResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: Pick<TranscriptLibraryError, "type" | "message" | "maxBytes"> };

export type TranscriptReadOperations = {
  [Key in keyof TranscriptReadRequests]: {
    input: { params: TranscriptReadRequests[Key]["input"]; readOnly?: boolean };
    output: TranscriptReadResult<TranscriptReadRequests[Key]["output"]>;
  };
};

export type TranscriptReadCommand = SqliteWorkerCommand<TranscriptReadOperations>;
