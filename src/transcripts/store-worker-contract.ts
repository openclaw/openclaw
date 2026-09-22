import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { TranscriptSessionDescriptor, TranscriptSourceLocator } from "./provider-types.js";
import type {
  queryTranscriptReadEntries,
  readLatestTranscriptEntry,
  readStoredTranscriptNotes,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
  TranscriptLibraryError,
  TranscriptReadPurpose,
} from "./store-read.js";
import type {
  readTranscriptExportOwnership,
  readTranscriptExportPathCollisions,
  readTranscriptExportPathOwners,
  readTranscriptSessionByIdentity,
  readTranscriptSessionEntries,
  readTranscriptSessionMatches,
  readStoredTranscriptSummary,
  readTranscriptUtterances,
  readTranscriptSummarySnapshot,
  readTranscriptJsonlDigest,
} from "./store-sqlite-read.js";
import type { writeMeetingTranscriptSummaryInDatabase } from "./store-sqlite-write.js";
import type {
  appendMeetingTranscriptUtterance,
  readRecentStoppedTranscriptSession,
  readTranscriptSummaryInputRevision,
} from "./store-sqlite.js";

type SessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;

/** Host-only capture scheduling; functions never cross the worker boundary. */
export type TranscriptAppendScheduler = (
  write: (assertCurrent: () => void) => Promise<void>,
) => Promise<void>;

export type TranscriptWriteOperations = {
  "transcripts.append": {
    input: Omit<Parameters<typeof appendMeetingTranscriptUtterance>[0], "database"> & {
      readOnly?: boolean;
    };
    output: void;
  };
  "transcripts.writeSummary": {
    input: {
      session: SessionIdentity;
      summaryValues: Parameters<typeof writeMeetingTranscriptSummaryInDatabase>[2];
      guard?: Parameters<typeof writeMeetingTranscriptSummaryInDatabase>[3];
      readOnly?: boolean;
    };
    output: { ok: true } | { ok: false; reason: "changed" };
  };
};

export type TranscriptWriteCommand = SqliteWorkerCommand<TranscriptWriteOperations>;

export type TranscriptReadRequests = {
  "transcripts.readEntries": {
    input: Parameters<typeof queryTranscriptReadEntries>[1];
    output: ReturnType<typeof queryTranscriptReadEntries>;
  };
  "transcripts.exportOwnership": {
    input: { session: SessionIdentity };
    output: ReturnType<typeof readTranscriptExportOwnership>;
  };
  "transcripts.exportPathCollisions": {
    input: { exportKey: string };
    output: ReturnType<typeof readTranscriptExportPathCollisions>;
  };
  "transcripts.exportPathOwners": {
    input: { exportKey: string };
    output: ReturnType<typeof readTranscriptExportPathOwners>;
  };
  "transcripts.summarySnapshot": {
    input: { session: SessionIdentity; maxUtterances: number };
    output: ReturnType<typeof readTranscriptSummarySnapshot>;
  };
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
  "transcripts.exportDigest": {
    input: { session: SessionIdentity };
    output: ReturnType<typeof readTranscriptJsonlDigest>;
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
