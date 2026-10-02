import type {
  SandboxRegistryInsert,
  SandboxRegistryWrite,
} from "../agents/sandbox/registry.kernel.js";
import type { SubagentRegistryWrite } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import type {
  WorkspaceAttestation,
  WorkspaceAttestationInput,
} from "../agents/workspace-state-store.kernel.js";
import type { ClawInstallSchemaVersionRow } from "../claws/provenance-runtime-read.kernel.js";
import type { ConfigHealthPatch } from "../config/io.health-state.kernel.js";
import type {
  ConfigHealthSnapshot,
  ConfigHealthEntryBasis,
} from "../config/io.health-state.types.js";
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
import type { PreparedSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { SqliteWorkerPreparedBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
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
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "deviceIdentity.read": { input: { identityKey: string }; output: DeviceIdentity | null };
    "deviceIdentity.load": { input: { identityKey: string }; output: DeviceIdentity };
    "sandboxRegistry.insertIfMissing": { input: SandboxRegistryInsert; output: void };
    "sandboxRegistry.write": { input: SandboxRegistryWrite; output: void };
    "workspace.replaceAttestation": {
      input: WorkspaceAttestationInput;
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
    "secrets.purge": { input: SecretStoreExpiryCutoffs; output: number };
    "secrets.writeForConfigRef": {
      input: SecretStoreConfigRefWrite;
      output: { name: string };
    };
    "subagents.persistChanges": { input: SubagentRegistryWrite; output: { writeId: string } };
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
    "config.health.read": { input: { artifactPreserving: boolean }; output: ConfigHealthSnapshot };
    "config.health.patch": {
      input: {
        configPath: string;
        patch: ConfigHealthPatch;
        expected: ConfigHealthEntryBasis | null | undefined;
        updatedAtMs: number;
      };
      output: boolean;
    };
    "diagnostic.register": {
      input: { scope: string; maxEntries: number; record: PreparedSqliteAuditRecord };
      output: void;
    };
    "config.snapshot.upsert": {
      input: { record: PreparedSqliteAuditRecord; expectedPayloadJson?: string | null };
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
  Pick<SkillUploadWorkerOperations, "skillUploads.release"> & {
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
      | keyof CaptureWorkerOperations
      | keyof PluginStateWorkerOperations
      | keyof OpenClawStateLeaseLifecycleOperations;
  }
>;

/** Host-only admission options; never serialized with a worker command. */
export type OpenClawStateWorkerOperationOptions = {
  preparation?: OpenClawStateWorkerOpenPreparation;
  existingOnly?: boolean;
  assertCurrent?: (commandType?: PropertyKey) => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
