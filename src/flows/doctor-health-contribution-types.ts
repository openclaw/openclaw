import type { RetiredAuthProfileCleanupPlan } from "../commands/doctor-auth-legacy-oauth.js";
import type { probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import type { DoctorConfigReferenceSource } from "../commands/doctor/shared/config-flow-steps.js";
import type { ShippedPluginInstallConfigImport } from "../commands/doctor/shared/plugin-registry-migration.js";
import type { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { buildGatewayConnectionDetails } from "../gateway/call.js";
import type {
  LegacyStateMigrationStepReceipt,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import type { UpdatePostInstallDoctorResult } from "../infra/update-doctor-result.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import type { DoctorUpdateBudget, DoctorUpdateWork } from "./doctor-update-budget.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheckContext } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorConfigResult = {
  cfg: OpenClawConfig;
  /** Original authored/resolved pair; retained across every committed Doctor write. */
  referenceSource?: DoctorConfigReferenceSource;
  pluginInstallConfigImport?: ShippedPluginInstallConfigImport;
  path?: string;
  shouldWriteConfig?: boolean;
  /** Active planning revision, advanced on success and cleared after partial publication. */
  confirmedConfigSource?: { path: string; hash: string | null };
  /** Repair panels held back until the atomic config write commits. */
  pendingChangePanels?: readonly string[];
  /** Billing changes reported once after the model migration is durable. */
  modelBillingRouteWarnings?: readonly string[];
  /** Successful retirement pass awaiting the config-write/no-change boundary. */
  modelRetirementRepairRan?: boolean;
  sourceConfigValid?: boolean;
  sourceLastTouchedVersion?: string;
  skipPluginValidationOnWrite?: boolean;
  explicitSetPaths?: readonly (readonly string[])[];
  persistCanonicalAgentRoster?: boolean;
  skipWizardMetadataForIncludeWrite?: boolean;
  preservedLegacyRootKeys?: readonly string[];
  shouldRepairCronCodexModelRefsAfterConfigWrite?: boolean;
  retiredPhoneControlStateCleanupPending?: boolean;
  /** Store cleanup deferred until the repaired config reaches disk. */
  retiredAuthProfileCleanupPlans?: readonly RetiredAuthProfileCleanupPlan[];
  blockedCodexModelIdentities?: readonly string[];
  /** Ephemeral doctor-only auth rename plan; never part of persisted config. */
  openAICodexAuthProfileIdMap?: ReadonlyMap<string, string>;
  /** Transient pre-retirement alias/default interpretation; current config owns auth and routes. */
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  invalidatePluginMetadataSnapshot?: () => void;
  stateMigrationStepReceipts?: LegacyStateMigrationStepReceipt[];
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
};

export type DoctorHealthFlowContext = {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  prompter: DoctorPrompter;
  configResult: DoctorConfigResult;
  cfg: OpenClawConfig;
  cfgForPersistence: OpenClawConfig;
  /** The finalized config-flow candidate crossed the atomic writer boundary. */
  configResultWriteCommitted?: boolean;
  /** The requested config write was refused; later repairs must not consume its candidate. */
  configWriteRefusal?: "validation" | "cron-owner-safety" | "include-ownership" | "config-conflict";
  /** A post-commit failure is terminal for this context; retry needs a fresh inspected snapshot. */
  configWriteError?: ConfigWritePostCommitError;
  /** One-shot repairs that require a durable config write have completed. */
  postConfigWriteRepairsCommitted?: boolean;
  sourceConfigValid: boolean;
  configPath: string;
  /** Whether the selected state directory already existed before doctor startup work. */
  stateDirExistedAtStart?: boolean;
  env?: NodeJS.ProcessEnv;
  /** State migration owns service activation until final readiness passes. */
  gatewayMaintenanceActive?: boolean;
  agentDatabaseRefusals?: readonly AgentDatabaseAdmissionRefusal[];
  preparedAgentCount?: number;
  updateBudget?: DoctorUpdateBudget;
  authProfileHealthReady?: boolean;
  gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
  healthOk?: boolean;
  gatewayHealthAuthenticated?: boolean;
  gatewayHealthSkipped?: boolean;
  gatewayStatus?: import("../status/summary.js").StatusSummary;
  gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
  postInstallDoctorResult?: UpdatePostInstallDoctorResult;
  updateWarnings?: string[];
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  invalidatePluginMetadataSnapshot?: () => void;
};

/** Internal facts carried through Doctor detect/repair/validate passes without widening the SDK. */
export type DoctorHealthCheckContext = HealthCheckContext & {
  /** Read-only lint validates the source once; mutable Doctor passes must reread it. */
  readonly lintConfigSnapshot?: Pick<ConfigFileSnapshot, "exists" | "issues" | "warnings">;
  readonly runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  readonly agentDatabaseRefusals?: readonly AgentDatabaseAdmissionRefusal[];
  /** The isolated lint worker retains its private state until these disposers settle. */
  readonly deferInspectionDisposal?: (dispose: () => Promise<void>) => void;
};

export type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  required?: true;
  /** Diagnostics with no update migration or readiness dependency stay in standalone Doctor. */
  updateWork?: DoctorUpdateWork;
  healthChecks: readonly DoctorHealthCheck[];
  healthCheckIds: readonly string[];
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

export type DoctorContributionHealthCheck = Omit<DoctorHealthCheck, "id" | "kind" | "source"> & {
  readonly id?: string;
  readonly kind?: "core";
  readonly source?: string;
};
