import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { UserProfile as UserProfileListItem } from "../../packages/gateway-protocol/src/schema/users.js";
import type {
  AcpSessionReadCommand,
  AcpSessionReadInput,
  AcpSessionReadResult,
  AcpSessionRow,
} from "../acp/runtime/session-meta-read.types.js";
import type { McpOAuthReadOnlyOperations } from "../agents/mcp-oauth-store.kernel.js";
import type {
  SandboxBrowserRegistryEntry,
  SandboxRegistryEntry,
} from "../agents/sandbox/registry.types.js";
import type {
  SubagentRunReadRecord,
  SubagentRunsDurableBasis,
} from "../agents/subagents/registry/subagent-registry-read.types.js";
import type {
  SubagentRunMaintenanceRecord,
  SubagentRunRecord,
} from "../agents/subagents/registry/subagent-registry.types.js";
import type { WorkspaceStateSnapshot } from "../agents/workspace-state-store.kernel.js";
import type { readWorktreeRunLeaseStateInDatabase } from "../agents/worktrees/run-lease-owner.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type {
  ExecutionIdentityInspectionQuery,
  ExecutionIdentityInspectionOutcome,
} from "../audit/execution-identity-inspection.types.js";
import type {
  ChannelIngressReadCommand,
  ChannelIngressReadReply,
} from "../channels/message/ingress-queue-read-contract.js";
import type { PersistedClawPackageRef } from "../claws/package-extension-provenance.js";
import type { ClawOrphanWorkspace, PersistedClawInstall } from "../claws/provenance-types.js";
import type { ConfigSnapshotAuditRecord } from "../config/config-journal-snapshot.kernel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronScratchReadCommand, CronScratchSnapshot } from "../cron/scratch-contract.js";
import type {
  CronRunReceiptCurrentFacts,
  CronRunReceiptCurrentReadCommand,
  CronRunReceiptOwnerObservation,
} from "../cron/store/run-receipt.types.js";
import type {
  CronRunRecoveryReadCommand,
  CronRunRecoveryObservation,
} from "../cron/store/run-recovery-read.types.js";
import type { CronQuarantinedJob } from "../cron/types-shared.js";
import type {
  PlacementGrantReadInput,
  PlacementGrantRows,
} from "../gateway/operator-approval-placement-grants.read.js";
import type {
  CronStandingGrantListing,
  CronStandingGrantLookupInput,
  ConsumeCronStandingGrantResult,
} from "../gateway/operator-approval-standing-grants.types.js";
import type {
  ListTerminalOperatorApprovalsInput,
  ListTerminalOperatorApprovalsResult,
} from "../gateway/operator-approval-store.types.js";
import type {
  SessionGroupCatalogSnapshot,
  SessionGroupMembershipSnapshot,
} from "../gateway/session-group-catalog.types.js";
import type {
  WorkerPlacementConflictBinding,
  WorkerPlacementRecoveryCandidate,
  WorkerSessionPlacementReadResult,
} from "../gateway/worker-environments/placement-read-projection.types.js";
import type {
  WorkerSessionPlacementChangeSnapshot,
  WorkerSessionPlacementRecord,
} from "../gateway/worker-environments/placement-record.js";
import type {
  WorkspaceJournalReadCommand,
  WorkspaceJournalReadResult,
} from "../gateway/worker-environments/placement-workspace-journal.types.js";
import type { PreparedPoolPresenceDemand } from "../gateway/worker-environments/prepared-pool-presence.types.js";
import type {
  WorkerEnvironmentFacts,
  WorkerEnvironmentPrunePage,
  WorkerEnvironmentPruneReadInput,
} from "../gateway/worker-environments/store.types.js";
import type {
  DevicePairingReadCommand,
  DevicePairingReadReply,
} from "../infra/device-pairing-read.types.js";
import type { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.types.js";
import type { OutboundDeliveryStorageEntry } from "../infra/outbound/delivery-queue-storage.types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding.types.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  readInterruptedUpdateCandidate,
  readUpdateRunRecord,
  readUpdateRuns,
  readUpdateRunStatusInDatabase,
  readUpdateRunHistoryStatusInDatabase,
  UpdateRunListInput,
} from "../infra/update-run-read.kernel.js";
import type {
  UpdateRunReconciliationInput,
  UpdateRunReconciliationCandidate,
} from "../infra/update-run-reconciliation.types.js";
import type {
  PluginBlobReadCommand,
  PluginBlobReadReply,
} from "../plugin-state/plugin-blob-worker-contract.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SkillLibraryReadOnlyOperations } from "../skills/library/selection-read.kernel.js";
import type {
  TranscriptExportCommand,
  TranscriptExportResult,
} from "../transcripts/store-export-contract.js";
import type { TuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import type {
  AgentDatabaseDeletionWorkerSnapshot,
  AgentDeletionJournalAuthority,
  AgentDeletionJournalPurpose,
  AgentDeletionJournalStatus,
} from "./agent-deletion-journal.types.js";
import type { BackupRunRecord } from "./backup-run-records.contract.js";
import type {
  SharedGitHubPublicationReadInput,
  GitHubPublicationReceiptTarget,
  GitHubPublicationRow,
  RepositoryGitHubPublicationReceiptTarget,
  RepositoryGitHubPublicationRow,
  GitHubPublicationSessionLifecycle,
} from "./github-publication-read.types.js";
import type { OnboardingRecommendationsRecord } from "./onboarding-recommendations.contract.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";
import type { ConfigMachineState } from "./openclaw-state-db.generated.js";
import type {
  RegisteredStateReadCommand,
  RegisteredStateReadResult,
} from "./openclaw-state-read-operation-registry.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";
import type {
  RepositoryWorkspaceOwner,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";
import type {
  UserProfileAvatarReadCommand,
  UserProfileAvatarReadReply,
} from "./user-profiles-avatar.types.js";
import type {
  UserChannelIdentitySelector,
  UserChannelIdentityLink,
  UserChannelIdentityAuthorityFacts,
  UserChannelIdentityResult,
  CachedGitHubIdentity,
  CachedGitHubIdentityBinding,
  UserProfileGitHubAttributionRead,
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileAuthority,
} from "./user-profiles.types.js";

type ConfigMachineStateRow = Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms">;

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

export type OpenClawStateReadCommand =
  | TranscriptExportCommand
  | RegisteredStateReadCommand
  | { type: "admit" }
  | { type: "backup.runs" }
  | TuiLastSessionReadCommand
  | ChannelIngressReadCommand
  | { type: "capture.readOnlyEvents"; sessionId: string; limit?: number }
  | { type: "capture.readOnlyBlob"; blobId: string }
  | { type: "deliveryQueue.outbound"; id?: string; mode: "pending" | "unfinished" }
  | { type: "config.snapshot.read" }
  | { type: "claws.packageOwnership"; agentId?: string; includeInstalls: boolean }
  | { type: "doctor.gatewayOwnerLease.read" }
  | AcpSessionReadCommand
  | SqliteWorkerCommand<McpOAuthReadOnlyOperations>
  | { type: "conversationBindings.inspect"; conversation: ConversationRef }
  | DevicePairingReadCommand
  | {
      type: "operatorApprovals.history";
      input: ListTerminalOperatorApprovalsInput;
    }
  | { type: "operatorApprovals.listCronGrants"; input: { limit?: number } }
  | { type: "operatorApprovals.validateCronGrant"; input: CronStandingGrantLookupInput }
  | { type: "operatorApprovals.placementGrant"; input: PlacementGrantReadInput }
  | PluginBlobReadCommand
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
            liveTopology: SubagentRunsDurableBasis["liveTopology"];
          };
    }
  | CronRunRecoveryReadCommand
  | CronRunReceiptCurrentReadCommand
  | CronScratchReadCommand
  | { type: "cron.activeReceiptOwners"; agentId: string }
  | { type: "cron.jobNames"; jobIds: string[]; storePath?: string }
  | { type: "cron.quarantine"; storeKey: string }
  | { type: "subagents.forChildSession"; childSessionKey: string }
  | { type: "exec-approvals.read" }
  | SqliteWorkerCommand<SkillLibraryReadOnlyOperations>
  | { type: "agentDatabaseRegistry.read" }
  | { type: "agentDatabaseDeletion.snapshot"; purpose: AgentDeletionJournalPurpose }
  | { type: "agentDeletionJournal.status"; agentId: string }
  | { type: "agentDeletionJournal.authority"; agentId: string }
  | { type: "workerEnvironments.snapshot"; ids?: readonly string[] }
  | { type: "workerEnvironments.pruneCandidates"; input: WorkerEnvironmentPruneReadInput }
  | { type: "sessionGroups.snapshot" }
  | { type: "sessionGroups.members"; cfg: OpenClawConfig }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.reconcile"; profileId: string }
  | UserProfileAvatarReadCommand
  | { type: "userProfiles.channelIdentity.list"; profileId: string }
  | { type: "userProfiles.channelIdentity.resolve"; identity: UserChannelIdentitySelector }
  | { type: "userProfiles.authority.resolve"; profileId: string; includeProfile?: boolean }
  | { type: "userProfiles.aliases.resolve"; profileId: string }
  | ({ type: "userProfiles.githubIdentity.cached" } & CachedGitHubIdentityBinding)
  | { type: "userProfiles.githubAttribution.resolve"; profileIds: readonly string[] }
  | { type: "userProfiles.email.resolve"; email: string }
  | { type: "userProfiles.catalog" }
  | { type: "userModelAccounts.links"; profileId: string }
  | { type: "userModelAccounts.summary"; profileId: string; authProfileId: string }
  | {
      type: "userModelAccounts.catalog";
      selection: import("./user-model-accounts.js").PersonalCatalogSelection;
    }
  | { type: "userPreferences.values"; profileIds: readonly string[]; key: string }
  | {
      type: "githubPublication.lifecycle";
      publicationKind: "shared" | "personal";
      requestId: string;
    }
  | { type: "githubPublication.sharedObservation"; input: SharedGitHubPublicationReadInput }
  | { type: "githubPublication.request"; requestId: string }
  | { type: "githubRepository.request"; requestId: string }
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
  | { type: "worktrees.list" }
  | { type: "workerPlacements.changeSnapshot"; profileIds?: string[] }
  | { type: "nodeHost.config" }
  | { type: "tts.prefsPath" }
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
  command: OpenClawStateReadCommand;
};
type ReadResult<Reply> = Reply extends { ok: true } ? Omit<Reply, "ok" | "sourceAdmitted"> : never;

export type OpenClawStateReadResult =
  | { type: "meetingTranscripts.export"; result: TranscriptExportResult }
  | RegisteredStateReadResult
  | { type: "backup.runs"; runs: BackupRunRecord[] }
  | {
      type: "claws.packageOwnership";
      install: PersistedClawInstall | undefined;
      installs: PersistedClawInstall[];
      packageRefs: PersistedClawPackageRef[];
      orphanWorkspace: ClawOrphanWorkspace | undefined;
    }
  | { type: "doctor.gatewayOwnerLease.read"; lease: GatewayOwnerLeaseIdentity | undefined }
  | { type: "preparedPoolPresence.read"; demand: PreparedPoolPresenceDemand | undefined }
  | {
      type: "tui.lastSession.read";
      row: ConfigMachineStateRow | undefined;
    }
  | ReadResult<ChannelIngressReadReply>
  | {
      type: "agentDeletionJournal.status";
      status: AgentDeletionJournalStatus;
    }
  | {
      type: "agentDeletionJournal.authority";
      authority: AgentDeletionJournalAuthority | undefined;
    }
  | {
      type: "deliveryQueue.outbound";
      entries: OutboundDeliveryStorageEntry[];
    }
  | {
      type: "config.snapshot.read";
      snapshot: ConfigSnapshotAuditRecord | null;
    }
  | AcpSessionReadResult
  | {
      [Kind in keyof McpOAuthReadOnlyOperations]: {
        type: Kind;
        value: McpOAuthReadOnlyOperations[Kind]["output"];
      };
    }[keyof McpOAuthReadOnlyOperations]
  | {
      type: "conversationBindings.inspect";
      record: SessionBindingRecord | null;
    }
  | ReadResult<DevicePairingReadReply>
  | {
      type: "operatorApprovals.history";
      history: ListTerminalOperatorApprovalsResult;
    }
  | { type: "operatorApprovals.listCronGrants"; grants: CronStandingGrantListing[] }
  | { type: "operatorApprovals.validateCronGrant"; result: ConsumeCronStandingGrantResult }
  | { type: "operatorApprovals.placementGrant"; rows: PlacementGrantRows }
  | ReadResult<PluginBlobReadReply>
  | {
      type: "capture.readOnlyEvents";
      events: Array<Record<string, unknown>>;
    }
  | {
      type: "capture.readOnlyBlob";
      blob: string | null;
    }
  | { type: "subagents.forChildSession"; runs: SubagentRunRecord[] }
  | {
      [Kind in keyof SkillLibraryReadOnlyOperations]: {
        type: Kind;
        value: SkillLibraryReadOnlyOperations[Kind]["output"];
      };
    }[keyof SkillLibraryReadOnlyOperations]
  | {
      type: "sessionGroups.members";
      snapshot: SessionGroupMembershipSnapshot;
    }
  | {
      type: "sessionGroups.snapshot";
      snapshot: SessionGroupCatalogSnapshot;
    }
  | {
      type: "userProfiles.email.resolve";
      profileId: string | undefined;
    }
  | {
      type: "githubPublication.lifecycle";
      lifecycle: GitHubPublicationSessionLifecycle | undefined;
    }
  | {
      type: "githubPublication.sharedObservation";
      row: GitHubPublicationRow | RepositoryGitHubPublicationRow | undefined;
    }
  | {
      type: "githubPublication.request";
      row: GitHubPublicationRow | undefined;
    }
  | {
      type: "githubRepository.request";
      row: RepositoryGitHubPublicationRow | undefined;
    }
  | {
      type: "githubPublication.knownPullRequestUrls";
      urls: string[];
    }
  | {
      type: "githubRepository.knownPullRequestUrls";
      urls: string[];
    }
  | {
      type: "cron.observeRunRecovery";
      observation: CronRunRecoveryObservation;
    }
  | { type: "cron.currentReceipt"; facts: CronRunReceiptCurrentFacts }
  | { type: "cron.quarantine"; entries: CronQuarantinedJob[] }
  | { type: "cron.scratch"; snapshot: CronScratchSnapshot | undefined }
  | {
      type: "cron.jobNames";
      storeKey: string;
      names: Map<string, string | undefined>;
    }
  | {
      type: "cron.activeReceiptOwners";
      owners: CronRunReceiptOwnerObservation[];
    }
  | {
      type: "subagents.sessionList";
      runs: Map<string, SubagentRunReadRecord>;
    }
  | {
      type: "subagents.sessionList";
      unavailable: { message: string; error: OpenClawStateWorkerErrorPayload | undefined };
    }
  | {
      type: "subagents.runs";
      projection?: never;
      runs: Map<string, SubagentRunRecord>;
      versions?: Map<string, string | null>;
      descendantBasis?: { digest: string; sessionKeys: Set<string>; runIds: readonly string[] };
    }
  | {
      type: "subagents.runs";
      projection: "maintenance";
      runs: Map<string, SubagentRunMaintenanceRecord>;
      maintenanceDigest: string;
    }
  | { type: "subagents.restore"; count: number }
  | {
      type: "agentDatabaseDeletion.snapshot";
      snapshot: AgentDatabaseDeletionWorkerSnapshot;
    }
  | {
      type: "workerEnvironments.pruneCandidates";
      page: WorkerEnvironmentPrunePage;
    }
  | {
      type: "workerEnvironments.snapshot";
      facts: WorkerEnvironmentFacts;
    }
  | {
      type: "onboardingRecommendations.read";
      record: OnboardingRecommendationsRecord | null;
    }
  | {
      type: "userProfiles.catalog";
      profiles: Array<[string, ProfileDisplayRow]>;
      emailBindings: UserProfileEmailBinding[];
    }
  | {
      type: "userPreferences.values";
      values: Map<string, unknown>;
    }
  | {
      type: "userModelAccounts.links";
      links: import("./user-model-accounts.js").UserProfileAuthLink[];
    }
  | {
      type: "userModelAccounts.summary";
      account: import("./user-model-accounts.js").UserModelAccount | undefined;
    }
  | {
      type: "userModelAccounts.catalog";
      catalog: import("./user-model-accounts.js").PersonalCatalogProfiles;
    }
  | {
      type: "userProfiles.reconcile";
      profile: ProfileDisplayRow | undefined;
      emailBindings: UserProfileEmailBinding[];
    }
  | UserProfileAvatarReadReply
  | {
      type: "userProfiles.channelIdentity.list";
      result: UserChannelIdentityResult<UserChannelIdentityLink[]>;
    }
  | {
      type: "userProfiles.channelIdentity.resolve";
      linked: UserChannelIdentityAuthorityFacts | undefined;
    }
  | {
      type: "userProfiles.authority.resolve";
      profile: (UserProfileAuthority & { listItem?: UserProfileListItem }) | undefined;
    }
  | { type: "userProfiles.aliases.resolve"; profileId: string; aliases: string[] }
  | {
      type: "userProfiles.githubIdentity.cached";
      identity: CachedGitHubIdentity | undefined;
    }
  | ({ type: "userProfiles.githubAttribution.resolve" } & UserProfileGitHubAttributionRead)
  | {
      type: "audit.run.inspect";
      result: ExecutionIdentityInspectionOutcome;
    }
  | {
      type: "exec-approvals.read";
      row: ReturnType<typeof readExecApprovalsConfigRow>;
    }
  | {
      type: "updateRuns.get";
      run: ReturnType<typeof readUpdateRunRecord>;
    }
  | {
      type: "updateRuns.list";
      runs: ReturnType<typeof readUpdateRuns>;
    }
  | {
      type: "updateRuns.interruptedCandidate";
      run: ReturnType<typeof readInterruptedUpdateCandidate>;
    }
  | { type: "updateRuns.reconciliationCandidates"; candidates: UpdateRunReconciliationCandidate[] }
  | {
      type: "updateRuns.reconciliationCandidate";
      candidate: UpdateRunReconciliationCandidate | undefined;
    }
  | { type: "updateRuns.status"; status: ReturnType<typeof readUpdateRunStatusInDatabase> }
  | {
      type: "updateRuns.historyStatus";
      status: ReturnType<typeof readUpdateRunHistoryStatusInDatabase>;
    }
  | {
      type: "worktrees.cleanupState";
      records: ManagedWorktreeRecord[];
      leases: ReturnType<typeof readWorktreeRunLeaseStateInDatabase>;
    }
  | { type: "worktrees.list"; records: ManagedWorktreeRecord[] }
  | {
      type: "workerPlacements.changeSnapshot";
      placements: WorkerSessionPlacementChangeSnapshot[];
    }
  | {
      type: "nodeHost.config" | "operator.channelPolicy" | "tts.prefsPath";
      row: ConfigMachineStateRow | undefined;
    }
  | {
      type: "sessionRepositoryWorkspaces.find";
      workspaces: SessionRepositoryWorkspaceRecord[];
    }
  | {
      type: "sessionRows.sharedFacts";
      rows: {
        acp?: AcpSessionRow | null;
        repositoryWorkspace?: SessionRepositoryWorkspaceRecord | null;
      }[];
    }
  | { type: "workspace.snapshot"; snapshot: WorkspaceStateSnapshot }
  | {
      type: "sandboxRegistry.list";
      entries: SandboxRegistryEntry[];
    }
  | {
      type: "sandboxRegistry.get";
      entry: SandboxRegistryEntry | null;
    }
  | { type: "sandboxRegistry.runtimeIds"; runtimeIds: string[] }
  | {
      type: "sandboxRegistry.browsers";
      entries: SandboxBrowserRegistryEntry[];
    }
  | WorkspaceJournalReadResult
  | { type: "workers.placementRecoveryCandidates"; candidates: WorkerPlacementRecoveryCandidate[] }
  | { type: "workers.placementPreservation"; placements: WorkerSessionPlacementRecord[] }
  | {
      type: "workers.placementEnvironmentOwner";
      placement: WorkerSessionPlacementRecord | undefined;
    }
  | {
      type: "workers.placementPendingResults";
      pendingResults: import("../gateway/worker-environments/placement-workspace-result.types.js").WorkerWorkspacePendingResult[];
    }
  | {
      type: "workers.placementProjection";
      result: WorkerSessionPlacementReadResult;
    };

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
  db: DatabaseSync;
  path: string;
};
