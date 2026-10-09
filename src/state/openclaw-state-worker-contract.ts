import type {
  SandboxRegistryCleanupOperations,
  SandboxRegistryInsert,
  SandboxRegistryOperations,
} from "../agents/sandbox/registry.kernel.js";
import type {
  SubagentRegistryWrite,
  SubagentRegistryWriteReceipt,
} from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import type {
  WorkspaceAttestation,
  WorkspaceAttestationInput,
} from "../agents/workspace-state-store.kernel.js";
import type {
  WorkspaceStateGuard,
  WorkspaceStateWorkerOperations,
} from "../agents/workspace-state-store.worker-contract.js";
import type { reserveWorktreeCapacityInWorker } from "../agents/worktrees/capacity.worker.js";
import type { recoverPendingWorktreesInWorker } from "../agents/worktrees/registry-run-end.worker.js";
import type { WorktreeTemplateWorkerOperations } from "../agents/worktrees/template-registry.worker.js";
import type { ClawInstallSchemaVersionRow } from "../claws/provenance-runtime-read.kernel.js";
import type { ConfigHealthPatch } from "../config/io.health-state.kernel.js";
import type { ConfigHealthEntryBasis } from "../config/io.health-state.types.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type { CronStateWorkerOperations } from "../cron/store/worker-contract.js";
import type {
  RepositoryGitHubPublicationPendingQuery,
  RepositoryGitHubPublicationStatusRow,
} from "../gateway/github-repository-publication.kernel.js";
import type {
  SessionGroupCatalogMutation,
  SessionGroupCatalogMutationResult,
} from "../gateway/session-group-catalog.types.js";
import type * as deviceAuth from "../infra/device-auth-store.kernel.js";
import type { DeviceIdentity } from "../infra/device-identity-store.js";
import type { RestartLifecycleWorkerOperations } from "../infra/restart-lifecycle.worker.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { SqliteWorkerPreparedBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerRuntimePreparation } from "../infra/sqlite-worker-runtime-preparation.types.js";
import type {
  InterruptedUpdateSettlement,
  InterruptedUpdateSettlementResult,
} from "../infra/update-run-interruption-contract.js";
import type { UpdateRunWriteOperations } from "../infra/update-run-mutation.types.js";
import type { UpdateRunReconciliationOperations } from "../infra/update-run-reconciliation.types.js";
import type { PluginStateWorkerOperations } from "../plugin-state/plugin-state-worker-contract.js";
import type { PluginMetadataStateSelector } from "../plugins/installed-plugin-index-row.js";
import type { CaptureWorkerOperations } from "../proxy-capture/store.worker-contract.js";
import type { SecretStoreConfigRefWrite } from "../secrets/store/secret-store-config-ref.kernel.js";
import type { SecretStoreExpiryCutoffs } from "../secrets/store/secret-store-expiry.kernel.js";
import type * as secretWrites from "../secrets/store/secret-store-write.js";
import type { SessionStateWorkerOperations } from "../sessions/session-state-events.worker-contract.js";
import type { SessionUpstreamLink } from "../sessions/session-upstream-links.kernel.js";
import type { SessionUpstreamWorkerOperations } from "../sessions/session-upstream-links.worker-contract.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import type { SkillUploadWorkerOperations } from "../skills/lifecycle/upload-store.worker-contract.js";
import type { TranscriptReadOperations } from "../transcripts/store-worker-contract.js";
import type { TuiLastSessionWorkerOperations } from "../tui/tui-last-session.contract.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import type { PreparedBackupRunRecord } from "./backup-run-records.kernel.js";
import type {
  GitHubSessionReceiptGeneration,
  GitHubSessionReceiptIdentities,
} from "./github-publication-read.types.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import type { RegisteredStateWorkerOperations } from "./openclaw-state-worker-registry.js";
import type { UserPreferenceWorkerOperations } from "./user-preferences.types.js";

export type OpenClawStateWorkerOpenPreparation = { type: "deviceIdentity"; identityKey: string };

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = RegisteredStateWorkerOperations &
  RestartLifecycleWorkerOperations &
  SandboxRegistryOperations &
  WorktreeTemplateWorkerOperations &
  WorkspaceStateWorkerOperations &
  UpdateRunReconciliationOperations &
  UpdateRunWriteOperations &
  CaptureWorkerOperations &
  TuiLastSessionWorkerOperations &
  SessionStateWorkerOperations &
  SessionUpstreamWorkerOperations &
  PluginStateWorkerOperations &
  UserPreferenceWorkerOperations &
  CronStateWorkerOperations &
  TranscriptReadOperations &
  OpenClawStateLeaseLifecycleOperations & {
    "worktrees.reserveCapacity": {
      input: Parameters<typeof reserveWorktreeCapacityInWorker>[0];
      output: ReturnType<typeof reserveWorktreeCapacityInWorker>;
    };
    "worktrees.recoverPending": {
      input: Parameters<typeof recoverPendingWorktreesInWorker>[0];
      output: ReturnType<typeof recoverPendingWorktreesInWorker>;
    };
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "deviceIdentity.read": { input: { identityKey: string }; output: DeviceIdentity | null };
    "deviceIdentity.load": { input: { identityKey: string }; output: DeviceIdentity };
    "sandboxRegistry.insertIfMissing": { input: SandboxRegistryInsert; output: void };
    "workspace.replaceAttestation": {
      input: WorkspaceAttestationInput & Pick<WorkspaceStateGuard, "recoveryHoldPredicate">;
      output: WorkspaceAttestation;
    };
    "updateRuns.reconcileInterrupted": {
      input: InterruptedUpdateSettlement;
      output: InterruptedUpdateSettlementResult;
    };
    "githubPublication.prepareSessionReceiptDeletion": {
      input: { agentId: string; sessionKeys: readonly string[] };
      output: GitHubSessionReceiptIdentities;
    };
    "githubPublication.deleteSessionReceipts": {
      input: {
        agentId: string;
        sessionKeys: readonly string[];
        generations: readonly GitHubSessionReceiptGeneration[];
        receipts: GitHubSessionReceiptIdentities;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      };
      output: void;
    };
    "githubRepository.personalPending": {
      input: RepositoryGitHubPublicationPendingQuery;
      output: RepositoryGitHubPublicationStatusRow | undefined;
    };
    "deviceAuth.prepare": { input: undefined; output: void };
    "deviceAuth.list": { input: { deviceId: string }; output: DeviceAuthEntry[] };
    "deviceAuth.read": {
      input: Parameters<typeof deviceAuth.readDeviceAuthTokenObservationFromDatabase>[1] & {
        readOnly: boolean;
      };
      output: ReturnType<typeof deviceAuth.readDeviceAuthTokenObservationFromDatabase>;
    };
    "deviceAuth.readOrigin": {
      input: Parameters<typeof deviceAuth.readOriginDeviceTokenObservationFromDatabase>[1] & {
        readOnly: boolean;
      };
      output: ReturnType<typeof deviceAuth.readOriginDeviceTokenObservationFromDatabase>;
    };
    "deviceAuth.store": {
      input: Parameters<typeof deviceAuth.storeDeviceAuthTokenInDatabase>[1];
      output: ReturnType<typeof deviceAuth.storeDeviceAuthTokenInDatabase>;
    };
    "deviceAuth.storeOrigin": {
      input: Parameters<typeof deviceAuth.storeOriginDeviceTokenInDatabase>[1];
      output: ReturnType<typeof deviceAuth.storeOriginDeviceTokenInDatabase>;
    };
    "deviceAuth.clear": {
      input: Parameters<typeof deviceAuth.clearDeviceAuthTokenFromDatabase>[1];
      output: ReturnType<typeof deviceAuth.clearDeviceAuthTokenFromDatabase>;
    };
    "deviceAuth.clearOrigin": {
      input: Parameters<typeof deviceAuth.clearOriginDeviceTokenInDatabase>[1];
      output: ReturnType<typeof deviceAuth.clearOriginDeviceTokenInDatabase>;
    };

    "agentProvenance.readBatch": {
      input: { agentIds: readonly string[] };
      output: AgentProvenance[];
    };
    "agentProvenance.list": { input: undefined; output: AgentProvenance[] };
    "agentProvenance.record": { input: AgentProvenance; output: void };
    "secrets.write": {
      input: Omit<secretWrites.SecretStoreBatchWriteParams, "database"> & {
        capturePrevious: boolean;
        now: number;
      };
      output: secretWrites.SecretStoreWriteResult[];
    };
    "secrets.rollback": {
      input: Omit<
        Parameters<typeof secretWrites.rollbackSecretStoreEntryWriteInDatabase>[0],
        "database"
      >;
      output: boolean;
    };
    "secrets.delete": {
      input: Omit<Parameters<typeof secretWrites.deleteSecretStoreEntryInDatabase>[0], "database">;
      output: void;
    };
    "secrets.purge": { input: SecretStoreExpiryCutoffs; output: number };
    "secrets.writeForConfigRef": {
      input: SecretStoreConfigRefWrite;
      output: { name: string };
    };
    "subagents.persistChanges": {
      input: SubagentRegistryWrite;
      output: SubagentRegistryWriteReceipt;
    };
    "sessionUpstream.listWatched": { input: undefined; output: SessionUpstreamLink[] };
    "backup.recordOutcome": { input: PreparedBackupRunRecord; output: void };
    "sessionGroups.mutate": {
      input: SessionGroupCatalogMutation;
      output: SessionGroupCatalogMutationResult;
    };
    "plugins.metadata.read": {
      input: { selector: PluginMetadataStateSelector; artifactPreservingReadOnly?: boolean };
      output: { value_json: string } | undefined;
    };
    "claws.install-schema-versions": {
      input: { artifactPreservingReadOnly: boolean };
      output: ClawInstallSchemaVersionRow[] | undefined;
    };
    "config.health.patch": {
      input: {
        configPath: string;
        patch: ConfigHealthPatch;
        expected: ConfigHealthEntryBasis | null | undefined;
        updatedAtMs: number;
      };
      output: boolean;
    };
  };

/** Internal inspection cannot open canonical state or execute a domain command. */
export type OpenClawStateWorkerInspectionOperations = {
  "database.generationMatches": { input: { generation: SqliteFileGeneration }; output: boolean };
  "database.inspectIdle": { input: undefined; output: "healthy" | "retire" };
};

/** Retiring owners dispatch only exact, physically bound cleanup receipts. */
export type OpenClawStateWorkerCleanupOperations = Pick<
  OpenClawStateLeaseLifecycleOperations,
  "stateLease.release"
> &
  Pick<SkillUploadWorkerOperations, "skillUploads.release"> &
  SandboxRegistryCleanupOperations & {
    "agentDatabases.releaseExitedLease": {
      input: OpenClawAgentDatabaseWorkerLeaseReceipt;
      output: void;
    };
  };

export type OpenClawStateWorkerBackend = SqliteWorkerPreparedBackend<
  OpenClawStateWorkerOperations &
    OpenClawStateWorkerInspectionOperations &
    OpenClawStateWorkerCleanupOperations
>;

/** Commands dispatched after the independently prepared backend paths. */
export type OpenClawStateWorkerRuntimeCommand = Exclude<
  Parameters<OpenClawStateWorkerBackend["execute"]>[0],
  {
    type:
      | "plugins.metadata.read"
      | "database.inspectIdle"
      | "database.walMaintenance"
      | "agentDatabases.releaseExitedLease"
      | "worktrees.reserveCapacity"
      | keyof RestartLifecycleWorkerOperations
      | Extract<keyof OpenClawStateWorkerOperations, `deviceAuth.${string}`>
      | keyof CaptureWorkerOperations
      | keyof PluginStateWorkerOperations
      | keyof WorktreeTemplateWorkerOperations
      | keyof OpenClawStateLeaseLifecycleOperations;
  }
>;

/** Host-only admission options; never serialized with a worker command. */
export type OpenClawStateWorkerOperationOptions = {
  preparation?: OpenClawStateWorkerOpenPreparation;
  runtimePreparation?: SqliteWorkerRuntimePreparation;
  existingOnly?: boolean;
  assertCurrent?: (commandType?: PropertyKey) => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
