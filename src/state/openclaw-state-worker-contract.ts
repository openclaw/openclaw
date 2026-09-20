import type { AuthProfileRowRead, UserModelAuthProfile } from "../agents/auth-profiles/types.js";
import type { NativeHookRelayStoreWorkerOperations } from "../agents/harness/native-hook-relay-store.worker-contract.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { AuditEventListQuery, AuditEventListPage } from "../audit/audit-event-types.js";
import type { AuditWriterOperations } from "../audit/audit-event-writer.types.js";
import type { ClawInstallSchemaVersionRow } from "../claws/provenance-runtime-read.kernel.js";
import type { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
import type { ConfigHealthPatch } from "../config/io.health-state.kernel.js";
import type {
  ConfigHealthSnapshot,
  ConfigHealthEntryBasis,
} from "../config/io.health-state.types.js";
import type { CronStoreWorkerOperations } from "../cron/store/load-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "../cron/store/save-worker.types.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.types.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordEntry,
} from "../gateway/managed-image-record-store.types.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import type { DeliveryQueueWorkerOperations } from "../infra/delivery-queue.worker-contract.js";
import type * as deviceAuth from "../infra/device-auth-store.kernel.js";
import type { PreparedPromotionClaim } from "../infra/promotions-feed.kernel.js";
import type { ApnsRegistration } from "../infra/push-apns-store.types.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { SessionDeliveryWorkerOperations } from "../infra/session-delivery-queue.worker-contract.js";
import type { PreparedSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import type { TelemetryWorkerOperations } from "../infra/telemetry-worker-contract.js";
import type { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import type { PluginStateWorkerOperations } from "../plugin-state/plugin-state-worker-contract.js";
import type { PluginBindingApprovalEntry } from "../plugins/conversation-binding-state.types.js";
import type { PluginMetadataStateSelector } from "../plugins/installed-plugin-index-row.js";
import type { HostedCatalogSnapshotWorkerOperations } from "../plugins/official-external-plugin-catalog-snapshot-store.worker-contract.js";
import type {
  ProjectRegistryIdentity,
  ProjectRegistryInsert,
  ProjectRegistryRecord,
} from "../projects/project-registry.kernel.js";
import type {
  SessionStateEventInput,
  SessionStateNotice,
} from "../sessions/session-state-events.kernel.js";
import type { SessionUpstreamLink } from "../sessions/session-upstream-links.kernel.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import type { commitSkillUploadInDatabase } from "../skills/lifecycle/upload-store-commit.js";
import type { SkillProposalEvent, SkillProposalRecord } from "../skills/workshop/types.js";
import type { TaskRegistryWorkerOperations } from "../tasks/task-registry.worker-contract.js";
import type { TranscriptReadOperations } from "../transcripts/store-worker-contract.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import type { PreparedBackupRunRecord } from "./backup-run-records.kernel.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import type { UserPreferenceWorkerOperations } from "./user-preferences.types.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = WebPushWorkerOperations &
  AuditWriterOperations &
  NativeHookRelayStoreWorkerOperations &
  TelemetryWorkerOperations &
  HostedCatalogSnapshotWorkerOperations &
  PluginStateWorkerOperations &
  UserPreferenceWorkerOperations &
  UserProfileWorkerOperations &
  CronStoreWorkerOperations &
  CronStoreSaveWorkerOperations &
  FleetRegistryWriteOperations &
  SessionDeliveryWorkerOperations &
  DeliveryQueueWorkerOperations &
  TranscriptReadOperations &
  TaskRegistryWorkerOperations & {
    "skillUploads.commit": {
      input: Parameters<typeof commitSkillUploadInDatabase>[0];
      output: ReturnType<typeof commitSkillUploadInDatabase>;
    };
    "audit.events.list": {
      input: AuditEventListQuery;
      output: AuditEventListPage;
    };
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

    "apns.registration.read": { input: string; output: ApnsRegistration | null };
    "apns.registrations.read": { input: readonly string[]; output: Map<string, ApnsRegistration> };
    "authProfiles.read": { input: { artifactPreserving: boolean }; output: AuthProfileRowRead };
    "authProfiles.sharedOwnership": { input: { artifactPreserving: boolean }; output: unknown };
    "authProfiles.personal": {
      input: { profileId: string; artifactPreserving: boolean };
      output: UserModelAuthProfile | undefined;
    };
    "agentProvenance.readBatch": {
      input: { agentIds: readonly string[] };
      output: AgentProvenance[];
    };
    "agentProvenance.list": { input: undefined; output: AgentProvenance[] };
    "promotions.markNotified": { input: { slugs: string[]; now: number }; output: true };
    "promotions.recordClaim": { input: PreparedPromotionClaim; output: void };
    "sessionState.recordGoalChange": {
      input: { event: SessionStateEventInput & { kind: "goal_changed" }; now: number };
      output: SessionStateNotice[];
    };
    "sessionState.prune": { input: { now: number }; output: void };
    "managedImages.read": { input: { attachmentId: string }; output: ManagedImageRecord | null };
    "managedImages.entries": { input: { sessionKey?: string }; output: ManagedImageRecordEntry[] };
    "managedImages.originalMediaIds": { input: undefined; output: string[] };
    "doctor.databaseBloat": {
      input: undefined;
      output: ReturnType<typeof readSqliteDatabaseBloat>;
    };
    "sessionUpstream.listWatched": { input: undefined; output: SessionUpstreamLink[] };
    "backup.recordOutcome": { input: PreparedBackupRunRecord; output: void };
    "projects.findRoot": { input: { repoRoot: string }; output: string | undefined };
    "projects.list": { input: undefined; output: ProjectRegistryRecord[] };
    "worktrees.list": { input: undefined; output: ManagedWorktreeRecord[] };
    "projects.resolve": { input: { id: string }; output: ProjectRegistryRecord | undefined };
    "projects.insert": {
      input: { project: ProjectRegistryInsert; lease: OpenClawStateLeaseIdentity };
      output: ProjectRegistryRecord;
    };
    "projects.remove": {
      input: { project: ProjectRegistryIdentity; lease: OpenClawStateLeaseIdentity };
      output: boolean;
    };
    "projects.resolveRefreshOwner": {
      input: { project: ProjectRegistryIdentity; lease: OpenClawStateLeaseIdentity };
      output: ProjectRegistryRecord | undefined;
    };
    "doctor.workshopMigrationRecords.read": {
      input: { includeEvents: boolean };
      output:
        | {
            records: Array<{ record: SkillProposalRecord; ownerAgentId: string | null }>;
            appliedEvents: SkillProposalEvent[];
          }
        | undefined;
    };
    "modelCatalog.remote.read": {
      input: { artifactPreservingReadOnly: boolean };
      output: ReturnType<typeof readRemoteModelCatalog>;
    };
    "plugins.conversationBindingApprovals.read": {
      input: undefined;
      output: PluginBindingApprovalEntry[];
    };
    "plugins.conversationBindingApprovals.upsert": {
      input: PluginBindingApprovalEntry;
      output: void;
    };
    "plugins.metadata.read": {
      input: { selector: PluginMetadataStateSelector; artifactPreservingReadOnly?: boolean };
      output: { value_json: string } | undefined;
    };
    "plugins.deferredMigrations.read": {
      input: undefined;
      output: readonly DeferredPluginMigration[];
    };
    "claws.install-schema-versions": {
      input: undefined;
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
  };

/** Internal inspection cannot open canonical state or execute a domain command. */
export type OpenClawStateWorkerInspectionOperations = {
  "database.generationMatches": { input: { generation: SqliteFileGeneration }; output: boolean };
  "database.inspectIdle": { input: undefined; output: "healthy" | "retire" };
};
