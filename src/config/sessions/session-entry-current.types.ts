import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
/** Identity is parser-validated; optional owner values retain their exact stored semantics. */
export type SessionEntryCurrentFacts = {
  sessionId: string;
  lifecycleRevision?: unknown;
  lifecycleRunId?: unknown;
  activeWriterRunId?: unknown;
  subagentRecovery?: {
    lastRunId?: unknown;
    sessionLifecycleRunId?: unknown;
  };
};

export type SessionEntryCurrentSource = CapturedSessionEntryReadSource &
  Readonly<{
    databaseIdentity: string;
    sessionKey: string;
  }>;

/** A current-row restriction; the caller's existing admission still supplies authority. */
export type SessionEntryCurrentCheck = Readonly<{
  source: SessionEntryCurrentSource;
  assertCurrent(facts: SessionEntryCurrentFacts | undefined): void;
}>;

export type SessionEntryCurrentPreparation =
  | { prepareCurrent?: () => Promise<boolean>; sessionEntryCurrent?: undefined }
  | { prepareCurrent: () => Promise<boolean>; sessionEntryCurrent?: SessionEntryCurrentCheck };

export type SessionEntryCurrentAdmissionFacts = {
  kind: "session-entry-current";
  source: SessionEntryCurrentSource;
  entry: SessionEntryCurrentFacts | undefined;
  domainFacts: unknown;
};
