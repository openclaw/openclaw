import type { SqliteWorkerEphemeralTarget } from "../../infra/sqlite-worker-contract.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import type { CommittedSessionSharingFacts } from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";
import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";
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
  initializationFingerprint?: string;
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
    | "projectId"
    | "worktree"
    | "pluginOwnerId"
  > & { worktreeId?: string };
  modelSelection?: Pick<
    SessionEntry,
    | "modelOverride"
    | "modelOverrideSource"
    | "providerOverride"
    | "modelOverrideRouteResolution"
    | "modelOverrideFallbackOriginProvider"
    | "modelOverrideFallbackOriginModel"
    | "agentRuntimeOverride"
    | "agentHarnessId"
    | "authProfileOverride"
    | "sandboxMode"
    | "nativeRuntimeConsent"
  >;
  policy?: Pick<
    SessionEntry,
    | "sessionId"
    | "sandbox"
    | "sandboxMode"
    | "createdActor"
    | "agentRuntimeOverride"
    | "nativeRuntimeConsent"
    | "permissionMode"
    | "execHost"
    | "execNode"
    | "execCwd"
    | "skillLibrarySelections"
    | "pluginOwnerId"
    | "agentHarnessId"
  >;
  cliHistory?: {
    boundary: SessionEntry["cliHistoryBoundary"];
    watermark: SessionTranscriptWatermark;
  };
  completionSources?: Array<{ sourceId: string; valid: boolean }>;
  steering?: Pick<
    SessionEntry,
    | "sessionId"
    | "updatedAt"
    | "lifecycleRevision"
    | "activeWriterRunId"
    | "restartRecoveryHarnessCompletion"
    | "restartRecoveryTerminalDeliveryEvidence"
    | "status"
    | "restartRecoveryDeliveryRunId"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryReceiptState"
    | "restartRecoveryDeliveryToolCallId"
    | "restartRecoveryTerminalRunIds"
    | "lifecycleRunId"
    | "startedAt"
    | "abortedLastRun"
    | "spawnDepth"
    | "subagentRole"
    | "restartRecoverySourceReplyDeliveryMode"
    | "restartRecoveryDeliveryContext"
    | "sendPolicy"
    | "chatType"
  > & {
    hasRecoveryClaim: boolean;
    pendingFinalDeliveryContext?: NonNullable<SessionEntry["pendingFinalDelivery"]>["context"];
  };
  expiresAt?: number;
};

export type IncognitoSessionAuthority = {
  assertCurrent(this: void): void;
  entryCreation?: SessionEntryCreationOperation;
  /** Synchronous host policy only. Never query the actor from a native grant. */
  authorize?(stage: "transaction" | "commit", facts: IncognitoSessionFacts): void;
};
