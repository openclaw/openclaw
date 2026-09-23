import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { AcpSessionReadInput, AcpSessionRow } from "../acp/runtime/session-meta-keys.js";
import type { McpOAuthReadOnlyOperations } from "../agents/mcp-oauth-store.kernel.js";
import type {
  SandboxBrowserRegistryEntry,
  SandboxRegistryEntry,
} from "../agents/sandbox/registry.types.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
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
import type { ConfigSnapshotAuditRecord } from "../config/config-journal-snapshot.kernel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronRunReceiptOwnerObservation } from "../cron/store/run-receipt.types.js";
import type {
  CronRunRecoveryReadCommand,
  CronRunRecoveryObservation,
} from "../cron/store/run-recovery-read.types.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
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
  WorkerSessionPlacementReadResult,
} from "../gateway/worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementChangeSnapshot } from "../gateway/worker-environments/placement-record.js";
import type {
  WorkerEnvironmentFacts,
  WorkerEnvironmentPrunePage,
  WorkerEnvironmentPruneReadInput,
} from "../gateway/worker-environments/store-worker-contract.js";
import type {
  DevicePairingReadCommand,
  DevicePairingReadReply,
} from "../infra/device-pairing-read.types.js";
import type { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import type { OutboundDeliveryStorageEntry } from "../infra/outbound/delivery-queue-storage.types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  readInterruptedUpdateCandidate,
  readUpdateRunRecord,
  readUpdateRuns,
  UpdateRunListInput,
} from "../infra/update-run-read.kernel.js";
import type {
  PluginBlobReadCommand,
  PluginBlobReadReply,
} from "../plugin-state/plugin-blob-worker-contract.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SkillLibraryReadOnlyOperations } from "../skills/library/selection-read.kernel.js";
import type { TaskRetentionSource } from "../tasks/task-registry-retention-source.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "../tasks/task-registry.store.types.js";
import type { TuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import type {
  AgentDatabaseDeletionSnapshot,
  AgentDeletionJournalPurpose,
  AgentDeletionJournalStatus,
} from "./agent-deletion-journal.types.js";
import type {
  GitHubPublicationReceiptTarget,
  GitHubPublicationRow,
  RepositoryGitHubPublicationReceiptTarget,
  RepositoryGitHubPublicationRow,
  GitHubPublicationSessionLifecycle,
} from "./github-publication-read.types.js";
import type { OnboardingRecommendationsRecord } from "./onboarding-recommendations.contract.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";
import type { ConfigMachineState } from "./openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";
import type { SessionRepositoryWorkspaceRecord } from "./session-repository-workspaces.types.js";
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
  UserProfileGitHubAttributionRead,
  UserProfileDisplay,
  ProfileDisplayRow,
  UserProfileEmailBinding,
} from "./user-profiles.types.js";

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
  | TuiLastSessionReadCommand
  | ChannelIngressReadCommand
  | { type: "deliveryQueue.outbound"; id?: string; mode: "pending" | "unfinished" }
  | { type: "config.snapshot.read" }
  | { type: "acpSessions.list" }
  | { type: "acpSessions.metadata"; entries: readonly AcpSessionReadInput[] }
  | {
      [Kind in keyof McpOAuthReadOnlyOperations]: {
        type: Kind;
        input: McpOAuthReadOnlyOperations[Kind]["input"];
      };
    }[keyof McpOAuthReadOnlyOperations]
  | { type: "conversationBindings.inspect"; conversation: ConversationRef }
  | DevicePairingReadCommand
  | {
      type: "operatorApprovals.history";
      input: ListTerminalOperatorApprovalsInput;
    }
  | PluginBlobReadCommand
  | { type: "subagents.sessionList" }
  | {
      type: "subagents.runs";
      scope: { kind: "session"; sessionKey: string } | { kind: "ids"; runIds: readonly string[] };
    }
  | CronRunRecoveryReadCommand
  | { type: "cron.activeReceiptOwners"; agentId: string }
  | { type: "cron.jobNames"; jobIds: string[]; storePath?: string }
  | { type: "subagents.forChildSession"; childSessionKey: string }
  | { type: "exec-approvals.read" }
  | {
      [Kind in keyof SkillLibraryReadOnlyOperations]: {
        type: Kind;
        input: SkillLibraryReadOnlyOperations[Kind]["input"];
      };
    }[keyof SkillLibraryReadOnlyOperations]
  | { type: "agentDatabaseRegistry.read" }
  | { type: "agentDatabaseDeletion.snapshot"; purpose: AgentDeletionJournalPurpose }
  | { type: "agentDeletionJournal.status"; agentId: string }
  | { type: "workerEnvironments.snapshot"; ids?: readonly string[] }
  | { type: "workerEnvironments.pruneCandidates"; input: WorkerEnvironmentPruneReadInput }
  | {
      type: "tasks.mutationSnapshot";
      input: TaskRegistryMutationScope | readonly TaskRegistryMutationScope[] | undefined;
    }
  | { type: "tasks.retentionSource"; taskId: string }
  | { type: "sessionGroups.snapshot" }
  | { type: "sessionGroups.members"; cfg: OpenClawConfig }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.reconcile"; profileId: string }
  | UserProfileAvatarReadCommand
  | { type: "userProfiles.channelIdentity.list"; profileId: string }
  | { type: "userProfiles.channelIdentity.resolve"; identity: UserChannelIdentitySelector }
  | { type: "userProfiles.authority.resolve"; profileId: string }
  | { type: "userProfiles.githubIdentity.cached"; accountId: number; email: string }
  | { type: "userProfiles.githubAttribution.resolve"; profileIds: readonly string[] }
  | { type: "userProfiles.email.resolve"; email: string }
  | { type: "userProfiles.catalog" }
  | { type: "userPreferences.values"; profileIds: readonly string[]; key: string }
  | {
      type: "githubPublication.lifecycle";
      publicationKind: "shared" | "personal";
      requestId: string;
    }
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
  | { type: "worktrees.cleanupState" }
  | { type: "fleet.list" }
  | { type: "workerPlacements.changeSnapshot"; profileIds?: string[] }
  | { type: "fleet.get"; tenantId: string }
  | { type: "nodeHost.config" }
  | { type: "operator.channelPolicy" }
  | {
      type: "sessionRepositoryWorkspaces.find";
      owners: readonly { agentId: string; sessionKey: string }[];
    }
  | { type: "workspace.snapshot"; workspaceDir: string }
  | { type: "sandboxRegistry.list" }
  | { type: "sandboxRegistry.get"; containerName: string }
  | { type: "sandboxRegistry.runtimeIds"; backendId: string; scopeKey: string }
  | { type: "sandboxRegistry.browsers" }
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
  command: OpenClawStateReadCommand | { type: "admit" };
};
type ReadResult<Reply> = Reply extends { ok: true } ? Omit<Reply, "ok" | "sourceAdmitted"> : never;

export type OpenClawStateReadResult =
  | {
      type: "tui.lastSession.read";
      row: Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms"> | undefined;
    }
  | { type: "tui.lastSession.retiredPointers"; stateKeys: string[] }
  | ReadResult<ChannelIngressReadReply>
  | {
      type: "agentDeletionJournal.status";
      status: AgentDeletionJournalStatus;
    }
  | {
      type: "deliveryQueue.outbound";
      entries: OutboundDeliveryStorageEntry[];
    }
  | {
      type: "config.snapshot.read";
      snapshot: ConfigSnapshotAuditRecord | null;
    }
  | {
      type: "acpSessions.list";
      rows: AcpSessionRow[];
    }
  | {
      type: "acpSessions.metadata";
      rows: Array<AcpSessionRow | null>;
    }
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
  | ReadResult<PluginBlobReadReply>
  | { type: "subagents.forChildSession"; runs: SubagentRunRecord[] }
  | {
      type: "tasks.mutationSnapshot";
      snapshot: TaskRegistryStoreSnapshot;
    }
  | {
      type: "tasks.retentionSource";
      source: TaskRetentionSource | undefined;
    }
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
  | {
      type: "cron.jobNames";
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
  | { type: "subagents.runs"; runs: Map<string, SubagentRunRecord> }
  | {
      type: "agentDatabaseDeletion.snapshot";
      snapshot: AgentDatabaseDeletionSnapshot;
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
      profile:
        | {
            profileId: string;
            role: string | null;
            aliases: string[];
            display: UserProfileDisplay;
          }
        | undefined;
    }
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
  | {
      type: "worktrees.cleanupState";
      records: ManagedWorktreeRecord[];
      leases: ReturnType<typeof readWorktreeRunLeaseStateInDatabase>;
    }
  | { type: "fleet.list"; cells: FleetCellRecord[] }
  | {
      type: "workerPlacements.changeSnapshot";
      placements: WorkerSessionPlacementChangeSnapshot[];
    }
  | { type: "fleet.get"; cell: FleetCellRecord | undefined }
  | {
      type: "nodeHost.config" | "operator.channelPolicy";
      row: Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms"> | undefined;
    }
  | {
      type: "sessionRepositoryWorkspaces.find";
      workspaces: SessionRepositoryWorkspaceRecord[];
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
  /** A best-effort admission read completed without confirmed native cleanup. */
  nativeCleanupFailure?: { error: OpenClawStateWorkerErrorPayload | undefined };
};

export type OpenClawStateReadOutcome =
  | { value: Extract<OpenClawStateReadReply, { ok: true }> }
  | { error: unknown; sourceAdmitted?: boolean };

export type OpenClawStateReadPhase = "before-read" | "read" | "unobserved";
export type OpenClawStateReadOptions = {
  /** Cancellation abandons delivery only after the accepted read and cleanup settle. */
  signal?: AbortSignal;
  /** Reuse the caller's captured authority instead of admitting a newer lifecycle. */
  context?: OpenClawStateWorkerContext;
  /** Publication and authority reads must not inherit an inspection snapshot. */
  current?: boolean;
  mapError?: (error: unknown, phase: OpenClawStateReadPhase) => unknown;
};

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
