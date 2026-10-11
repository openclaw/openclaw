import type { SqliteWorkerEphemeralTarget } from "../../infra/sqlite-worker-contract.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import type { CommittedSessionSharingFacts } from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Content-free postimage; full entries remain owned by the requesting read. */
export type IncognitoSessionFacts = {
  identity: Readonly<SqliteWorkerEphemeralTarget>;
  sessionKey: string;
  revision: number;
  sharing: CommittedSessionSharingFacts | undefined;
  capability?: SessionEntryCurrentFacts;
  chatMetadataRevision?: string;
  entryReadRevision?: string;
  delivery?: Pick<SessionEntry, "sessionId" | "updatedAt" | "delivery">;
  media?: Pick<
    SessionEntry,
    | "sessionId"
    | "updatedAt"
    | "lifecycleRevision"
    | "permissionMode"
    | "execNode"
    | "repositoryWorkspaceId"
    | "sessionRoot"
    | "spawnedCwd"
    | "spawnedWorkspaceDir"
    | "pendingWorktree"
    | "pendingProjectGitUrl"
  > & { worktreeId?: string };
  completionSources?: Array<{ sourceId: string; valid: boolean }>;
  steering?: Pick<
    SessionEntry,
    | "sessionId"
    | "updatedAt"
    | "lifecycleRevision"
    | "restartRecoveryHarnessCompletion"
    | "restartRecoveryTerminalDeliveryEvidence"
    | "status"
    | "restartRecoveryDeliveryRunId"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryReceiptState"
    | "restartRecoveryDeliveryToolCallId"
    | "restartRecoveryTerminalRunIds"
  >;
  expiresAt?: number;
};

export type IncognitoSessionAuthority = {
  assertCurrent(this: void): void;
  entryCreation?: SessionEntryCreationOperation;
  /** Synchronous host policy only. Never query the actor from a native grant. */
  authorize?(stage: "transaction" | "commit", facts: IncognitoSessionFacts): void;
};
