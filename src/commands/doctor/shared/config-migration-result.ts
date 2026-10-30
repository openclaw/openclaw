import { isDeepStrictEqual } from "node:util";
import type { ConfigSnapshotReadMeasure } from "../../../config/io.js";
import { copyConfigResolutionFactsThroughRewrite } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeferredPluginMigration } from "../../../infra/deferred-plugin-migrations.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../../../infra/state-migrations.media-persistence-targets.js";
import type {
  LegacyStateMigrationInvocationPurpose,
  LegacyStateMigrationStepReceipt,
  PreparedPostSessionPluginMigration,
} from "../../../infra/state-migrations.types.js";
import type { PluginCache } from "../../../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { AutomaticHeartbeatRepairAdmission } from "../../doctor-automatic-heartbeat-repair.js";
import type { DoctorOptions, DoctorPrompter } from "../../doctor-prompter.js";
import type { CronCodexRuntimePolicyTarget } from "../cron/store-migration.js";

export type DoctorConfigPreflightOptions = {
  /** The full Doctor flow admits retired sources before entering maintenance. */
  retiredStateAdmitted?: boolean;
  stateSchemaPreparation?: LegacyStateMigrationStepReceipt;
  /** Scoped updater normalization after maintenance and verified database backup admission. */
  automaticHeartbeatRepair?: AutomaticHeartbeatRepairAdmission;
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  integrityCheck?: "quick" | "full";
  migrateState?: boolean;
  /** Select Doctor normalization without enabling repair-only migrations. */
  invocationPurpose?: LegacyStateMigrationInvocationPurpose;
  migrateLegacyConfig?: boolean;
  repairPrefixedConfig?: boolean;
  invalidConfigNote?: string | false;
  observe?: boolean;
  measure?: ConfigSnapshotReadMeasure;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
  /** Interactive Doctor resolves a moved partition before consuming legacy heartbeat inputs. */
  cronStoreSelection?: { options: DoctorOptions; prompter?: DoctorPrompter };
  /** Load one authoritative plugin metadata snapshot for the caller's full lifecycle. */
  preparePluginMetadataSnapshot?: boolean;
  /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
  doctorOnlyStateMigrations?: boolean;
};

export type DoctorConfigPreflightResult = {
  /** Caller owns retirement after consuming the final metadata snapshot. */
  pluginCache?: PluginCache;
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  /** Repair diagnostics retained for managed update parents, not only terminal notes. */
  warnings?: string[];
  /** Original resolved roster retained until its config and data migrations finish. */
  rosterMigrationSource?: OpenClawConfig;
  rosterMigrationOwnerId?: string;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  modelBillingRouteMigrationSource?: OpenClawConfig;
  heartbeatMigrationSource?: OpenClawConfig;
  /** Keep retired config intact until an operator selects its destination partition. */
  heartbeatMigrationDeferred?: true;
  /** Cron work waits for a partition; unrelated config repairs remain available. */
  cronStoreSelectionUnresolved?: true;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  cronCodexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
  stateMigrationStepReceipts?: LegacyStateMigrationStepReceipt[];
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
  /** Config whose pre-session state migrations completed without unresolved work. */
  preflightLegacyStateConfig?: OpenClawConfig;
};

/** Keep migrated selectors with Doctor's model-policy owner until billing facts are captured. */
export async function retainHeartbeatMigrationInput(
  config: OpenClawConfig,
  source: OpenClawConfig | undefined,
): Promise<OpenClawConfig> {
  const candidate = structuredClone(config);
  if (source?.agents?.defaults?.heartbeat && candidate.agents) {
    candidate.agents.defaults ??= {};
    candidate.agents.defaults.heartbeat = structuredClone(source.agents.defaults.heartbeat);
  }
  for (const [agentId, entry] of Object.entries(candidate.agents?.entries ?? {})) {
    const heartbeat = source?.agents?.entries?.[agentId]?.heartbeat;
    if (heartbeat) {
      entry.heartbeat = structuredClone(heartbeat);
    }
  }
  if (source) {
    const { resolveLegacyHeartbeatAgents } = await import("../../doctor-heartbeat-legacy.js");
    const { resolveHeartbeatAutomationModel } = await import("../../doctor-heartbeat-model.js");
    for (const { agentId, heartbeat } of resolveLegacyHeartbeatAgents(candidate)) {
      const entry = candidate.agents?.entries?.[agentId];
      const fallback = resolveHeartbeatAutomationModel(candidate, agentId).fallback;
      if (entry && heartbeat) {
        const { agentId: _agentId, ...perAgentHeartbeat } = heartbeat;
        // Materialize every inherited owner before changing any selector's billing provenance.
        entry.heartbeat = {
          ...perAgentHeartbeat,
          ...(fallback ? { model: fallback.defaultModel } : {}),
        };
      }
    }
  }
  copyConfigResolutionFactsThroughRewrite(config, candidate);
  return candidate;
}

/** Preserve migration provenance before repairs, then prepare the post-write health handoff. */
export function prepareDoctorConfigMigrationResult(
  preflight: DoctorConfigPreflightResult,
  snapshot: ConfigFileSnapshot,
) {
  const sourceVersion = snapshot.sourceConfig.meta?.lastTouchedVersion;
  const sourceLastTouchedVersion = typeof sourceVersion === "string" ? sourceVersion : undefined;
  const billingRouteSource =
    preflight.modelBillingRouteMigrationSource ??
    snapshot.sourceConfigBeforeMigrations ??
    snapshot.sourceConfig;
  return async (params: {
    cfg: OpenClawConfig;
    modelBillingRouteConfig?: OpenClawConfig;
    shouldWriteConfig: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
    pluginInventoryChanged?: boolean;
    runWithCurrentPluginMetadata: <T>(config: OpenClawConfig, run: () => T) => T;
  }) => {
    let modelBillingRouteWarnings: string[] = [];
    // Heartbeat model intent moves to jobs before retired config fields disappear.
    const billingRouteConfig = params.modelBillingRouteConfig ?? params.cfg;
    if (
      (params.shouldWriteConfig || preflight.modelBillingRouteMigrationSource) &&
      (!isDeepStrictEqual(billingRouteSource.agents, billingRouteConfig.agents) ||
        !isDeepStrictEqual(billingRouteSource.models, billingRouteConfig.models))
    ) {
      const { collectModelBillingRouteMigrationWarnings } =
        await import("./model-billing-route-migration.js");
      modelBillingRouteWarnings = params.runWithCurrentPluginMetadata(params.cfg, () =>
        collectModelBillingRouteMigrationWarnings({
          before: billingRouteSource,
          after: billingRouteConfig,
          metadataSnapshot: params.metadataSnapshot,
        }),
      );
    }
    let receipts = preflight.stateMigrationStepReceipts;
    let postSession = preflight.postSessionPluginMigration;
    const planBound = preflight.postSessionPluginMigrationPlanBound;
    if (planBound && params.pluginInventoryChanged && postSession) {
      const { preparePostSessionPluginMigration } =
        await import("../../../infra/state-migrations.plugin-plan.js");
      const { resolveLivePluginDoctorStateMigrationInventory } =
        await import("../../../plugins/doctor-contract-registry.js");
      // Installation replaces the selected owner generation after preflight. Freeze
      // that generation before session writers; never reopen a blocked handoff.
      postSession = params.runWithCurrentPluginMetadata(params.cfg, () =>
        preparePostSessionPluginMigration({
          mode: "doctor",
          inventory: resolveLivePluginDoctorStateMigrationInventory({
            config: params.cfg,
            env: process.env,
          }),
        }),
      );
      if (postSession.step.refusal) {
        const { createLegacyStateMigrationStepReceipt } =
          await import("../../../infra/state-migrations.messages.js");
        receipts = [
          ...(receipts ?? []),
          createLegacyStateMigrationStepReceipt(postSession.step, {
            changes: [],
            warnings: [postSession.step.refusal.message],
          }),
        ];
        postSession = undefined;
      }
    }
    return {
      ...(sourceLastTouchedVersion ? { sourceLastTouchedVersion } : {}),
      ...(modelBillingRouteWarnings.length > 0 ? { modelBillingRouteWarnings } : {}),
      ...(params.metadataSnapshot ? { pluginMetadataSnapshot: params.metadataSnapshot } : {}),
      ...(receipts ? { stateMigrationStepReceipts: receipts } : {}),
      ...(postSession ? { postSessionPluginMigration: postSession } : {}),
      ...(planBound ? { postSessionPluginMigrationPlanBound: true } : {}),
      ...(!params.shouldWriteConfig &&
      !params.pluginInventoryChanged &&
      isDeepStrictEqual(preflight.preflightLegacyStateConfig, params.cfg)
        ? { preflightLegacyStateConfig: preflight.preflightLegacyStateConfig }
        : {}),
    };
  };
}
