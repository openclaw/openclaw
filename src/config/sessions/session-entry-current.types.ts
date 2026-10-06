import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
/** Identity is parser-validated; optional owner values retain their exact stored semantics. */
export type SessionEntryCurrentFacts = {
  sessionId: string;
  previousSessionId?: unknown;
  archivedAt?: unknown;
  repositoryWorkspaceId?: unknown;
  lifecycleRevision?: unknown;
  lifecycleRunId?: unknown;
  activeWriterRunId?: unknown;
  spawnedBy?: unknown;
  spawnDepth?: unknown;
  completionOwnerSessionKey?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
  inheritedToolPolicyVersion?: unknown;
  inheritedToolPolicySource?: unknown;
  inheritedToolAllow?: unknown;
  inheritedToolDeny?: unknown;
  subagentRecovery?: {
    lastRunId?: unknown;
    sessionLifecycleRunId?: unknown;
  };
};

export type SessionEntryCurrentSource = CapturedSessionEntryReadSource &
  Readonly<{
    databaseIdentity: string;
    sessionKey: string;
    sessionIdLookup?: string;
    projection?: "capability";
  }>;

/** A current-row restriction; the caller's existing admission still supplies authority. */
export type SessionEntryCurrentCheck = Readonly<{
  source: SessionEntryCurrentSource;
  assertCurrent(facts: SessionEntryCurrentFacts | undefined): void;
}>;

/** One predicate can depend on several source-bound rows, including absent exact-key probes. */
export type SessionEntriesCurrentCheck = Readonly<{
  sources: readonly SessionEntryCurrentSource[];
  assertCurrent(entries: readonly (SessionEntryCurrentFacts | undefined)[]): void;
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

export type CapturedSessionEntryCurrentRead =
  | {
      kind: "file";
      source: SessionEntryCurrentSource;
      assertSourceCurrent(this: void): void;
      readCurrent(): Promise<SessionEntryCurrentFacts | undefined>;
    }
  | {
      kind: "native" | "missing";
      source?: undefined;
      assertSourceCurrent(this: void): void;
      readCurrent(): SessionEntryCurrentFacts | undefined;
    };
