import type { NativeHookRelayStoreWorkerOperations } from "../agents/harness/native-hook-relay-store.worker-contract.js";
import type { ClawInstallSchemaVersionRow } from "../claws/provenance-runtime-read.kernel.js";
import type { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
import type { ConfigHealthPatch } from "../config/io.health-state.kernel.js";
import type {
  ConfigHealthSnapshot,
  ConfigHealthEntryBasis,
} from "../config/io.health-state.types.js";
import type { CronStoreWorkerOperations } from "../cron/store/load-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "../cron/store/save-worker.types.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import type { DeliveryQueueWorkerOperations } from "../infra/delivery-queue.worker-contract.js";
import type { DeviceIdentity } from "../infra/device-identity-store.js";
import type { PreparedPromotionClaim } from "../infra/promotions-feed.kernel.js";
import type { ApnsRegistration } from "../infra/push-apns-store.types.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { SessionDeliveryWorkerOperations } from "../infra/session-delivery-queue.worker-contract.js";
import type { PreparedSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
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
import type { TaskRegistryWorkerOperations } from "../tasks/task-registry.worker-contract.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import type { PreparedBackupRunRecord } from "./backup-run-records.kernel.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import type { UserPreferenceWorkerOperations } from "./user-preferences.types.js";

export type OpenClawStateWorkerOpenPreparation = {
  type: "deviceIdentity";
  identityKey: string;
};

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = WebPushWorkerOperations &
  NativeHookRelayStoreWorkerOperations &
  HostedCatalogSnapshotWorkerOperations &
  PluginStateWorkerOperations &
  UserPreferenceWorkerOperations &
  CronStoreWorkerOperations &
  CronStoreSaveWorkerOperations &
  SessionDeliveryWorkerOperations &
  DeliveryQueueWorkerOperations &
  TaskRegistryWorkerOperations & {
    "deviceIdentity.read": { input: { identityKey: string }; output: DeviceIdentity | null };
    "deviceIdentity.load": { input: { identityKey: string }; output: DeviceIdentity };
    "apns.registration.read": { input: string; output: ApnsRegistration | null };
    "apns.registrations.read": { input: readonly string[]; output: Map<string, ApnsRegistration> };
    "agentProvenance.read": {
      input: { agentId: string };
      output: AgentProvenance | undefined;
    };
    "agentProvenance.list": { input: undefined; output: AgentProvenance[] };
    "promotions.markNotified": { input: { slugs: string[]; now: number }; output: true };
    "promotions.recordClaim": { input: PreparedPromotionClaim; output: void };
    "sessionState.recordGoalChange": {
      input: { event: SessionStateEventInput & { kind: "goal_changed" }; now: number };
      output: SessionStateNotice[];
    };
    "sessionState.prune": { input: { now: number }; output: void };
    "doctor.databaseBloat": {
      input: undefined;
      output: ReturnType<typeof readSqliteDatabaseBloat>;
    };
    "backup.recordOutcome": { input: PreparedBackupRunRecord; output: void };
    "projects.findRoot": { input: { repoRoot: string }; output: string | undefined };
    "projects.list": { input: undefined; output: ProjectRegistryRecord[] };
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
};
