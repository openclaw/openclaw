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
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "../tasks/task-registry.store.types.js";
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
  | { type: "deliveryQueue.outbound"; id?: string; mode: "pending" | "unfinished" }
  | { type: "config.snapshot.read" }
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
  | { type: "sessionGroups.snapshot" }
  | { type: "sessionGroups.members"; cfg: OpenClawConfig }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.reconcile"; profileId: string }
  | { type: "userProfiles.channelIdentity.list"; profileId: string }
  | { type: "userProfiles.channelIdentity.resolve"; identity: UserChannelIdentitySelector }
  | { type: "userProfiles.authority.resolve"; profileId: string }
  | { type: "userProfiles.githubIdentity.cached"; accountId: number; email: string }
  | { type: "userProfiles.githubAttribution.resolve"; profileIds: readonly string[] }
  | { type: "userProfiles.email.resolve"; email: string }
  | { type: "userProfiles.catalog" }
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
export type OpenClawStateReadReply = (
  | {
      ok: true;
      type: "agentDeletionJournal.status";
      sourceAdmitted: true;
      status: AgentDeletionJournalStatus;
    }
  | {
      ok: true;
      type: "deliveryQueue.outbound";
      sourceAdmitted: true;
      entries: OutboundDeliveryStorageEntry[];
    }
  | {
      ok: true;
      type: "config.snapshot.read";
      sourceAdmitted: true;
      snapshot: ConfigSnapshotAuditRecord | null;
    }
  | {
      ok: true;
      type: "acpSessions.metadata";
      sourceAdmitted: true;
      rows: Array<AcpSessionRow | null>;
    }
  | {
      [Kind in keyof McpOAuthReadOnlyOperations]: {
        ok: true;
        type: Kind;
        sourceAdmitted: true;
        value: McpOAuthReadOnlyOperations[Kind]["output"];
      };
    }[keyof McpOAuthReadOnlyOperations]
  | {
      ok: true;
      type: "conversationBindings.inspect";
      sourceAdmitted: true;
      record: SessionBindingRecord | null;
    }
  | DevicePairingReadReply
  | {
      ok: true;
      type: "operatorApprovals.history";
      sourceAdmitted: true;
      history: ListTerminalOperatorApprovalsResult;
    }
  | PluginBlobReadReply
  | { ok: true; type: "subagents.forChildSession"; sourceAdmitted: true; runs: SubagentRunRecord[] }
  | {
      ok: true;
      type: "tasks.mutationSnapshot";
      sourceAdmitted: true;
      snapshot: TaskRegistryStoreSnapshot;
    }
  | {
      [Kind in keyof SkillLibraryReadOnlyOperations]: {
        ok: true;
        type: Kind;
        sourceAdmitted: true;
        value: SkillLibraryReadOnlyOperations[Kind]["output"];
      };
    }[keyof SkillLibraryReadOnlyOperations]
  | {
      ok: true;
      type: "sessionGroups.members";
      sourceAdmitted: true;
      snapshot: SessionGroupMembershipSnapshot;
    }
  | {
      ok: true;
      type: "sessionGroups.snapshot";
      sourceAdmitted: true;
      snapshot: SessionGroupCatalogSnapshot;
    }
  | {
      ok: true;
      type: "userProfiles.email.resolve";
      sourceAdmitted: true;
      profileId: string | undefined;
    }
  | {
      ok: true;
      type: "githubPublication.lifecycle";
      sourceAdmitted: true;
      lifecycle: GitHubPublicationSessionLifecycle | undefined;
    }
  | {
      ok: true;
      type: "githubPublication.request";
      sourceAdmitted: true;
      row: GitHubPublicationRow | undefined;
    }
  | {
      ok: true;
      type: "githubRepository.request";
      sourceAdmitted: true;
      row: RepositoryGitHubPublicationRow | undefined;
    }
  | {
      ok: true;
      type: "githubPublication.knownPullRequestUrls";
      sourceAdmitted: true;
      urls: string[];
    }
  | {
      ok: true;
      type: "githubRepository.knownPullRequestUrls";
      sourceAdmitted: true;
      urls: string[];
    }
  | {
      ok: true;
      type: "cron.observeRunRecovery";
      sourceAdmitted: true;
      observation: CronRunRecoveryObservation;
    }
  | {
      ok: true;
      type: "cron.jobNames";
      sourceAdmitted: true;
      names: Map<string, string | undefined>;
    }
  | {
      ok: true;
      type: "cron.activeReceiptOwners";
      sourceAdmitted: true;
      owners: CronRunReceiptOwnerObservation[];
    }
  | {
      ok: true;
      type: "subagents.sessionList";
      sourceAdmitted: true;
      runs: Map<string, SubagentRunReadRecord>;
    }
  | {
      ok: true;
      type: "subagents.sessionList";
      sourceAdmitted: true;
      unavailable: { message: string; error: OpenClawStateWorkerErrorPayload | undefined };
    }
  | { ok: true; type: "subagents.runs"; sourceAdmitted: true; runs: Map<string, SubagentRunRecord> }
  | {
      ok: true;
      type: "agentDatabaseRegistry.read";
      sourceAdmitted?: true;
      result: OpenClawAgentDatabaseRegistryReadResult;
    }
  | {
      ok: true;
      type: "agentDatabaseDeletion.snapshot";
      sourceAdmitted: true;
      snapshot: AgentDatabaseDeletionSnapshot;
    }
  | {
      ok: true;
      type: "workerEnvironments.pruneCandidates";
      sourceAdmitted: true;
      page: WorkerEnvironmentPrunePage;
    }
  | {
      ok: true;
      type: "workerEnvironments.snapshot";
      sourceAdmitted: true;
      facts: WorkerEnvironmentFacts;
    }
  | {
      ok: true;
      type: "onboardingRecommendations.read";
      sourceAdmitted: true;
      record: OnboardingRecommendationsRecord | null;
    }
  | {
      ok: true;
      type: "userProfiles.catalog";
      sourceAdmitted: true;
      profiles: Array<[string, ProfileDisplayRow]>;
      emailBindings: UserProfileEmailBinding[];
    }
  | {
      ok: true;
      type: "userProfiles.reconcile";
      sourceAdmitted: true;
      profile: ProfileDisplayRow | undefined;
      emailBindings: UserProfileEmailBinding[];
    }
  | {
      ok: true;
      type: "userProfiles.channelIdentity.list";
      sourceAdmitted: true;
      result: UserChannelIdentityResult<UserChannelIdentityLink[]>;
    }
  | {
      ok: true;
      type: "userProfiles.channelIdentity.resolve";
      sourceAdmitted: true;
      linked: UserChannelIdentityAuthorityFacts | undefined;
    }
  | {
      ok: true;
      type: "userProfiles.authority.resolve";
      sourceAdmitted: true;
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
      ok: true;
      type: "userProfiles.githubIdentity.cached";
      sourceAdmitted: true;
      identity: CachedGitHubIdentity | undefined;
    }
  | ({
      ok: true;
      type: "userProfiles.githubAttribution.resolve";
      sourceAdmitted: true;
    } & UserProfileGitHubAttributionRead)
  | {
      ok: true;
      type: "audit.run.inspect";
      sourceAdmitted: true;
      result: ExecutionIdentityInspectionOutcome;
    }
  | { ok: true; type: "admit" }
  | {
      ok: true;
      type: "exec-approvals.read";
      sourceAdmitted: true;
      row: ReturnType<typeof readExecApprovalsConfigRow>;
    }
  | {
      ok: true;
      type: "updateRuns.get";
      sourceAdmitted: true;
      run: ReturnType<typeof readUpdateRunRecord>;
    }
  | {
      ok: true;
      type: "updateRuns.list";
      sourceAdmitted: true;
      runs: ReturnType<typeof readUpdateRuns>;
    }
  | {
      ok: true;
      type: "updateRuns.interruptedCandidate";
      sourceAdmitted: true;
      run: ReturnType<typeof readInterruptedUpdateCandidate>;
    }
  | {
      ok: true;
      type: "worktrees.cleanupState";
      sourceAdmitted: true;
      records: ManagedWorktreeRecord[];
      leases: ReturnType<typeof readWorktreeRunLeaseStateInDatabase>;
    }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | {
      ok: true;
      type: "workerPlacements.changeSnapshot";
      sourceAdmitted: true;
      placements: WorkerSessionPlacementChangeSnapshot[];
    }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      ok: true;
      type: "nodeHost.config" | "operator.channelPolicy";
      sourceAdmitted: true;
      row: Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms"> | undefined;
    }
  | {
      ok: true;
      type: "sessionRepositoryWorkspaces.find";
      sourceAdmitted: true;
      workspaces: SessionRepositoryWorkspaceRecord[];
    }
  | { ok: true; type: "workspace.snapshot"; sourceAdmitted: true; snapshot: WorkspaceStateSnapshot }
  | {
      ok: true;
      type: "sandboxRegistry.list";
      sourceAdmitted: true;
      entries: SandboxRegistryEntry[];
    }
  | {
      ok: true;
      type: "sandboxRegistry.get";
      sourceAdmitted: true;
      entry: SandboxRegistryEntry | null;
    }
  | { ok: true; type: "sandboxRegistry.runtimeIds"; sourceAdmitted: true; runtimeIds: string[] }
  | {
      ok: true;
      type: "sandboxRegistry.browsers";
      sourceAdmitted: true;
      entries: SandboxBrowserRegistryEntry[];
    }
  | {
      ok: true;
      type: "workers.placementProjection";
      sourceAdmitted: true;
      result: WorkerSessionPlacementReadResult;
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
