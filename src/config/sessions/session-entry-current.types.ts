import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionEntry } from "./types.js";
/** Identity is parser-validated; optional owner values retain their exact stored semantics. */
export type SessionEntryCurrentFacts = {
  sessionId: string;
  incognito?: SessionEntry["incognito"];
  modelSelectionLocked?: SessionEntry["modelSelectionLocked"];
  pluginOwnerId?: SessionEntry["pluginOwnerId"];
  agentHarnessId?: SessionEntry["agentHarnessId"];
  agentRuntimeOverride?: SessionEntry["agentRuntimeOverride"];
  initializationPending?: SessionEntry["initializationPending"];
  execHost?: SessionEntry["execHost"];
  execNode?: SessionEntry["execNode"];
  sandbox?: SessionEntry["sandbox"];
  sandboxMode?: SessionEntry["sandboxMode"];
  permissionMode?: SessionEntry["permissionMode"];
  sessionRoot?: SessionEntry["sessionRoot"];
  authProfileOverride?: SessionEntry["authProfileOverride"];
  authProfileOverrideSource?: SessionEntry["authProfileOverrideSource"];
  modelOverride?: SessionEntry["modelOverride"];
  providerOverride?: SessionEntry["providerOverride"];
  model?: SessionEntry["model"];
  modelProvider?: SessionEntry["modelProvider"];
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
  delegatedToolPolicy?: unknown;
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
      kind: "native" | "incognito" | "missing";
      source?: undefined;
      assertSourceCurrent(this: void): void;
      readCurrent(): SessionEntryCurrentFacts | undefined;
    };
