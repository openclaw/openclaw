import { isDeepStrictEqual } from "node:util";
import type { ConfigSnapshotReadMeasure } from "../../../config/io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeferredPluginMigration } from "../../../infra/deferred-plugin-migrations.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../../../infra/state-migrations.media-persistence-targets.js";
import type {
  LegacyStateMigrationInvocationPurpose,
  LegacyStateMigrationStepReceipt,
  PreparedPostSessionPluginMigration,
} from "../../../infra/state-migrations.types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { CronCodexRuntimePolicyTarget } from "../cron/store-migration.js";

export type DoctorConfigPreflightOptions = {
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  migrateState?: boolean;
  /** Select Doctor normalization without enabling repair-only migrations. */
  invocationPurpose?: LegacyStateMigrationInvocationPurpose;
  migrateLegacyConfig?: boolean;
  repairPrefixedConfig?: boolean;
  recoverCorruptTargetStore?: boolean;
  invalidConfigNote?: string | false;
  observe?: boolean;
  measure?: ConfigSnapshotReadMeasure;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
  /** Load one authoritative plugin metadata snapshot for the caller's full lifecycle. */
  preparePluginMetadataSnapshot?: boolean;
  /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
  doctorOnlyStateMigrations?: boolean;
};

export type DoctorConfigPreflightResult = {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  modelBillingRouteMigrationSource?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  cronCodexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
  stateMigrationStepReceipts?: LegacyStateMigrationStepReceipt[];
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
};

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
    shouldWriteConfig: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
    pluginInventoryChanged?: boolean;
    runWithCurrentPluginMetadata: <T>(config: OpenClawConfig, run: () => T) => T;
  }) => {
    let modelBillingRouteWarnings: string[] = [];
    if (
      (params.shouldWriteConfig || preflight.modelBillingRouteMigrationSource) &&
      (!isDeepStrictEqual(billingRouteSource.agents, params.cfg.agents) ||
        !isDeepStrictEqual(billingRouteSource.models, params.cfg.models))
    ) {
      const { collectModelBillingRouteMigrationWarnings } =
        await import("./model-billing-route-migration.js");
      modelBillingRouteWarnings = params.runWithCurrentPluginMetadata(params.cfg, () =>
        collectModelBillingRouteMigrationWarnings({
          before: billingRouteSource,
          after: params.cfg,
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
    };
  };
}
