import type { McpOAuthReadOperations } from "../agents/mcp-oauth-store.kernel.js";
import type { ClawInstallSchemaVersionRow } from "../claws/provenance-runtime-read.kernel.js";
import type { ConfigHealthPatch } from "../config/io.health-state.kernel.js";
import type {
  ConfigHealthSnapshot,
  ConfigHealthEntryBasis,
} from "../config/io.health-state.types.js";
import type { CronStoreWorkerOperations } from "../cron/store/load-worker.types.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.types.js";
import type { SessionDeliveryWorkerOperations } from "../infra/session-delivery-queue.worker-contract.js";
import type { PreparedSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import type { PluginStateWorkerOperations } from "../plugin-state/plugin-state-worker-contract.js";
import type { PluginMetadataStateSelector } from "../plugins/installed-plugin-index-row.js";
import type { TaskFlowView } from "../plugins/runtime/task-domain-types.js";
import type { ManagedTaskInFlowInput } from "../tasks/task-flow-managed-run-task.kernel.js";
import type { RunTaskInFlowResult } from "../tasks/task-flow-managed-run-task.types.js";
import type {
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdateResult,
} from "../tasks/task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskRegistryStatusSnapshot } from "../tasks/task-registry.store.status.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "../tasks/task-registry.store.types.js";
import type { TaskRecord, TaskRegistrySummary } from "../tasks/task-registry.types.js";
import type { PreparedBackupRunRecord } from "./backup-run-records.kernel.js";
import type { OnboardingRecommendationWriteOperations } from "./onboarding-recommendations.contract.js";
import type { UserPreferenceWorkerOperations } from "./user-preferences.types.js";

type TaskLookupRecords = {
  direct?: TaskRecord;
  byRun?: TaskRecord;
  related: TaskRecord[];
};

type TaskFlowRead = {
  flow: TaskFlowRecord;
  tasks: TaskRecord[];
};

type TaskFlowReadQuery = {
  ownerKey: string;
  lookup: "id" | "latest" | "resolve";
  token?: string;
};

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = PluginStateWorkerOperations &
  UserPreferenceWorkerOperations &
  OnboardingRecommendationWriteOperations &
  CronStoreWorkerOperations &
  FleetRegistryWriteOperations &
  SessionDeliveryWorkerOperations &
  McpOAuthReadOperations & {
    "backup.recordOutcome": { input: PreparedBackupRunRecord; output: void };
    "projects.findRoot": { input: { repoRoot: string }; output: string | undefined };
    "plugins.metadata.read": {
      input: { selector: PluginMetadataStateSelector; artifactPreservingReadOnly?: boolean };
      output: { value_json: string } | undefined;
    };
    "claws.install-schema-versions": {
      input: undefined;
      output: ClawInstallSchemaVersionRow[] | undefined;
    };
    "tasks.statusSummary": {
      input: { now: number; preserveSourceArtifacts: boolean };
      output: TaskRegistryStatusSnapshot | undefined;
    };
    "flows.runTask": { input: ManagedTaskInFlowInput; output: RunTaskInFlowResult };
    "tasks.mutationSnapshot": {
      input: TaskRegistryMutationScope;
      output: TaskRegistryStoreSnapshot;
    };
    "flows.createManaged": {
      input: { flow: TaskFlowRecord };
      output: TaskFlowRecord;
    };
    "flows.updateManaged": {
      input: TaskFlowRegistryUpdate & {
        ownerKey: string;
      };
      output:
        | TaskFlowRegistryUpdateResult
        | { applied: false; reason: "not_managed"; current: TaskFlowRecord }
        | { applied: false; reason: "persist_failed"; current?: TaskFlowRecord };
    };
    "flows.current": { input: { flowId: string }; output: TaskFlowRecord | undefined };
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
    "tasks.get": { input: { taskId: string }; output: TaskRecord | undefined };
    "tasks.list": { input: { ownerKey: string }; output: TaskRecord[] };
    "tasks.resolve": {
      input: { ownerKey: string; token: string };
      output: TaskLookupRecords;
    };
    "flows.list": { input: { ownerKey: string }; output: TaskFlowRecord[] };
    "flows.views": { input: { ownerKey: string }; output: TaskFlowView[] };
    "flows.summary": {
      input: { ownerKey: string; flowId: string };
      output: TaskRegistrySummary | undefined;
    };
    "flows.read": {
      input: TaskFlowReadQuery;
      output: TaskFlowRecord | undefined;
    };
    "flows.detail": {
      input: TaskFlowReadQuery;
      output: TaskFlowRead | undefined;
    };
  };

/** Internal inspection cannot open canonical state or execute a domain command. */
export type OpenClawStateWorkerInspectionOperations = {
  "database.generationMatches": { input: { generation: SqliteFileGeneration }; output: boolean };
};
