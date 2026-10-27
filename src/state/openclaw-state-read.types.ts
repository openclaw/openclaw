import type {
  AcpSessionReadCommand,
  AcpSessionReadInput,
} from "../acp/runtime/session-meta-read.types.js";
import type { McpOAuthReadOnlyOperations } from "../agents/mcp-oauth-store.kernel.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ExecutionIdentityInspectionQuery } from "../audit/execution-identity-inspection.types.js";
import type { ChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronScratchReadCommand } from "../cron/scratch-contract.js";
import type { CronRunReceiptCurrentReadCommand } from "../cron/store/run-receipt.types.js";
import type { PlacementGrantReadInput } from "../gateway/operator-approval-placement-grants.read.worker.js";
import type { CronStandingGrantLookupInput } from "../gateway/operator-approval-standing-grants.types.js";
import type { ListTerminalOperatorApprovalsInput } from "../gateway/operator-approval-store.types.js";
import type {
  LocalWorkspaceManifestInput,
  LocalWorkspaceManifestValue,
} from "../gateway/worker-environments/local-workspace-manifest-scan.js";
import type { WorkerPlacementConflictBinding } from "../gateway/worker-environments/placement-read-projection.types.js";
import type { WorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import type { DevicePairingReadCommand } from "../infra/device-pairing-read.types.js";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.types.js";
import type { ConversationRef } from "../infra/outbound/session-binding.types.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { UpdateRunListInput } from "../infra/update-run-read.kernel.js";
import type { UpdateRunReconciliationInput } from "../infra/update-run-reconciliation.types.js";
import type { PluginBlobReadCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import type { PluginStateReadCommand } from "../plugin-state/plugin-state-worker-contract.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SkillLibraryReadOnlyOperations } from "../skills/library/selection-read.kernel.js";
import type {
  TranscriptExportCommand,
  TranscriptExportResult,
} from "../transcripts/store-export-contract.js";
import type { TuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import type { AgentDeletionJournalPurpose } from "./agent-deletion-journal.types.js";
import type {
  GitHubPublicationReceiptTarget,
  RepositoryGitHubPublicationReceiptTarget,
} from "./github-publication-read.types.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";
import type {
  RegisteredStateReadCommand,
  RegisteredStateReadResult,
} from "./openclaw-state-read-operation-registry.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";
import type { RepositoryWorkspaceOwner } from "./session-repository-workspaces.types.js";
import type { UserBackgroundReadCommand } from "./user-background.types.js";
import type { UserProfileAvatarReadCommand } from "./user-profiles-avatar.types.js";
import type {
  UserChannelIdentitySelector,
  CachedGitHubIdentityBinding,
} from "./user-profiles.types.js";

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
  postgresSnapshot?: string;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

export type OpenClawStateReadCommand =
  | TranscriptExportCommand
  | RegisteredStateReadCommand
  | { type: "localWorkspace.manifest"; input: LocalWorkspaceManifestInput }
  | { type: "admit" }
  | { type: "backup.runs" }
  | TuiLastSessionReadCommand
  | ChannelIngressReadCommand
  | { type: "capture.readOnlyEvents"; sessionId: string; limit?: number }
  | { type: "capture.readOnlyBlob"; blobId: string }
  | { type: "deliveryQueue.outbound"; id?: string; mode: "pending" | "unfinished" }
  | { type: "config.snapshot.read" }
  | { type: "claws.inventory" }
  | { type: "gatewayOwnerLease.read"; schemaMaintenance: boolean }
  | AcpSessionReadCommand
  | SqliteWorkerCommand<McpOAuthReadOnlyOperations>
  | { type: "conversationBindings.inspect"; conversation: ConversationRef }
  | DevicePairingReadCommand
  | {
      type: "operatorApprovals.history";
      input: ListTerminalOperatorApprovalsInput;
    }
  | {
      type: "operatorApprovals.pendingSnapshot";
      input: { cursor?: string };
    }
  | {
      type: "operatorApprovals.pending";
      input: Parameters<
        typeof import("../gateway/operator-approval-store.kernel.worker.js").readPendingOperatorApprovalsInDatabase
      >[0];
    }
  | {
      type: "operatorApprovals.prepareReplay";
      input: Parameters<
        typeof import("../gateway/operator-approval-store.kernel.worker.js").readOperatorApprovalReplayInDatabase
      >[0];
    }
  | { type: "operatorApprovals.listCronGrants"; input: { limit?: number } }
  | { type: "operatorApprovals.validateCronGrant"; input: CronStandingGrantLookupInput }
  | { type: "operatorApprovals.placementGrant"; input: PlacementGrantReadInput }
  | PluginBlobReadCommand
  | PluginStateReadCommand
  | { type: "subagents.sessionList" }
  | { type: "subagents.restore" }
  | {
      type: "subagents.runs";
      scope:
        | { kind: "maintenance" }
        | { kind: "session"; sessionKey: string }
        | { kind: "ids"; runIds: readonly string[] }
        | {
            kind: "descendants";
            sessionKeys: readonly string[];
            liveTopology: readonly Pick<
              SubagentRunRecord,
              "childSessionKey" | "requesterSessionKey"
            >[];
          };
    }
  | CronRunReceiptCurrentReadCommand
  | CronScratchReadCommand
  | { type: "cron.jobNames"; jobIds: string[]; storePath?: string }
  | { type: "cron.quarantine"; storeKey: string }
  | { type: "exec-approvals.read" }
  | SqliteWorkerCommand<SkillLibraryReadOnlyOperations>
  | { type: "agentDatabaseRegistry.read" }
  | { type: "agentDatabaseDeletion.snapshot"; purpose: AgentDeletionJournalPurpose }
  | { type: "agentDeletionJournal.status"; agentId: string }
  | { type: "agentDeletionJournal.retainedIds" }
  | { type: "workerEnvironments.snapshot"; ids?: readonly string[] }
  | { type: "sessionGroups.snapshot" }
  | { type: "sessionGroups.members"; cfg: OpenClawConfig }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.reconcile"; profileId: string }
  | UserBackgroundReadCommand
  | UserProfileAvatarReadCommand
  | { type: "userProfiles.channelIdentity.list"; profileId: string }
  | { type: "userProfiles.channelIdentity.resolve"; identity: UserChannelIdentitySelector }
  | ({ type: "userProfiles.githubIdentity.cached" } & CachedGitHubIdentityBinding)
  | { type: "userProfiles.githubAttribution.resolve"; profileIds: readonly string[]; host?: string }
  | { type: "userProfiles.catalog" }
  | {
      type: "userProfiles.catalogIdentity";
      input: import("./user-profile-catalog-identity.read.js").UserProfileCatalogIdentityInput;
    }
  | { type: "userModelAccounts.authorization"; authProfileId: string }
  | { type: "userModelAccounts.links"; profileId: string }
  | { type: "userModelAccounts.summary"; profileId: string; authProfileId: string }
  | { type: "userModelAccounts.selection"; profileId?: string; authProfileId: string }
  | {
      type: "userModelAccounts.catalog";
      selection: import("./user-model-accounts.js").PersonalCatalogSelection;
    }
  | { type: "userPreferences.sessionPins" }
  | { type: "userPreferences.values"; profileIds: readonly string[]; key: string }
  | { type: "userPreferences.read"; profileId: string; keys?: readonly string[] }
  | {
      type: "githubPublication.lifecycle";
      publicationKind: "shared" | "personal";
      requestId: string;
    }
  | { type: "githubPublication.request"; requestId: string }
  | { type: "githubPublication.knownPullRequestUrls"; input: GitHubPublicationReceiptTarget }
  | {
      type: "githubRepository.knownPullRequestUrls";
      input: RepositoryGitHubPublicationReceiptTarget;
    }
  | { type: "audit.run.inspect"; input: ExecutionIdentityInspectionQuery }
  | { type: "updateRuns.get"; runId: string }
  | { type: "updateRuns.list"; input: UpdateRunListInput }
  | { type: "updateRuns.interruptedCandidate" }
  | { type: "updateRuns.reconciliationCandidates"; input: UpdateRunReconciliationInput }
  | { type: "updateRuns.reconciliationCandidate"; runId: string }
  | { type: "updateRuns.status" }
  | { type: "updateRuns.historyStatus" }
  | { type: "worktrees.cleanupState" }
  | { type: "workerPlacements.changeSnapshot"; profileIds?: string[] }
  | { type: "nodeHost.config" }
  | { type: "cron.store" }
  | { type: "hooks.internal.installs" }
  | { type: "tts.prefsPath" }
  | { type: "voicewake.triggers" }
  | { type: "voicewake.routing" }
  | { type: "operator.channelPolicy" }
  | { type: "preparedPoolPresence.read" }
  | {
      type: "sessionRepositoryWorkspaces.find";
      owners: readonly RepositoryWorkspaceOwner[];
    }
  | {
      type: "sessionRows.sharedFacts";
      entries: readonly {
        acp?: AcpSessionReadInput;
        repositoryWorkspace?: RepositoryWorkspaceOwner & { workspaceId: string };
      }[];
    }
  | { type: "workspace.snapshot"; workspaceDir: string }
  | { type: "sandboxRegistry.list" }
  | { type: "sandboxRegistry.get"; containerName: string }
  | { type: "sandboxRegistry.runtimeIds"; backendId: string; scopeKey: string }
  | { type: "sandboxRegistry.browsers" }
  | WorkspaceJournalReadCommand
  | { type: "workers.placementRecoveryCandidates" }
  | { type: "workers.placementPreservation" }
  | { type: "workers.placementEnvironmentOwner"; environmentId: string }
  | { type: "workers.placementPendingResults"; sessionId?: string }
  | {
      type: "workers.placementProjection";
      sessionIds: readonly string[];
      conflictBindings: readonly WorkerPlacementConflictBinding[];
    };
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
  postgresSnapshot?: string;
  /** Keep an admitted read worker's MVCC snapshot until the retained owner drains. */
  exportPostgresSnapshot?: true;
  command: OpenClawStateReadCommand;
};
type ReadResult<Reply> = Reply extends { ok: true } ? Omit<Reply, "ok" | "sourceAdmitted"> : Reply;

export type OpenClawStateReadResult =
  | ReadResult<
      ReturnType<
        typeof import("./openclaw-state-read-handlers.js").readOpenClawStateDatabaseCommand
      >
    >
  | { type: "meetingTranscripts.export"; result: TranscriptExportResult }
  | RegisteredStateReadResult
  | { type: "localWorkspace.manifest"; value: LocalWorkspaceManifestValue }
  | { type: "gatewayOwnerLease.read"; lease: GatewayOwnerLeaseIdentity | undefined }
  | {
      type: "subagents.sessionList";
      runs: Map<string, SubagentRunReadRecord>;
    }
  | {
      type: "subagents.sessionList";
      unavailable: { message: string; error: OpenClawStateWorkerErrorPayload | undefined };
    }
  | { type: "subagents.restore"; count: number };

export type OpenClawStateReadReply = (
  | ({ ok: true; sourceAdmitted: true } & OpenClawStateReadResult)
  | { ok: true; type: "admit" }
  | {
      ok: true;
      type: "agentDatabaseRegistry.read";
      sourceAdmitted?: true;
      result: OpenClawAgentDatabaseRegistryReadResult;
    }
  | {
      ok: false;
      sourceAdmitted?: true;
      message: string;
      error: OpenClawStateWorkerErrorPayload | undefined;
    }
) & {
  /** Native cleanup requires worker exit, possibly after a successful read. */
  nativeCleanupFailure?: { error: OpenClawStateWorkerErrorPayload | undefined };
};

export type OpenClawStateReadOutcome =
  | { value: Extract<OpenClawStateReadReply, { ok: true }> }
  | { error: unknown; sourceAdmitted?: boolean };

type OpenClawStateReadPhase = "before-read" | "read" | "unobserved";
export type OpenClawStateReadReceipt = { phase: OpenClawStateReadPhase };
export type OpenClawStateReadOptions = {
  /** Cancellation abandons delivery only after the accepted read and cleanup settle. */
  signal?: AbortSignal;
  /** Reuse the caller's captured authority instead of admitting a newer lifecycle. */
  context?: OpenClawStateWorkerContext;
  /** Publication and authority reads must not inherit an inspection snapshot. */
  current?: boolean;
  /** Active writers may observe live rows; their lifecycle drains the retained reader. */
  live?: true;
  /** Named committed-status readers may reopen the matching retained warm source. */
  preferIndependentWarmRead?: true;
  /** Promise-only callers can retain their snapshot child without synchronous servicing. */
  snapshotPreparation?: "awaited";
  mapError?: (error: unknown, phase: OpenClawStateReadPhase) => unknown;
} & (
  | {
      /** Consume private streamed facts synchronously; final settlement owns publication. */
      onChunk?: (value: unknown) => void;
      onChunkAsync?: never;
    }
  | {
      onChunk?: never;
      /** Hold backpressure and read custody until consumption settles, including cancellation. */
      onChunkAsync: (value: unknown, signal: AbortSignal) => Promise<void>;
    }
);

export type ReadResource = { close(): Promise<void> };
export type RetainedReadScope = {
  path: string;
  active: boolean;
  work: AsyncWorkScope;
  resources: Set<ReadResource>;
  close(): Promise<void>;
};

export type OpenClawStateReadOnlyDatabase = {
  db: EngineConnection;
  path: string;
};
