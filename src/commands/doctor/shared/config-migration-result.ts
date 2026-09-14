import { isDeepStrictEqual } from "node:util";
import type { ConfigSnapshotReadMeasure } from "../../../config/io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  LegacyStateMigrationStepReceipt,
  PreparedPostSessionPluginMigration,
} from "../../../infra/state-migrations.types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { CronCodexRuntimePolicyTarget } from "../cron/store-migration.js";

export type DoctorConfigPreflightOptions = {
  migrateState?: boolean;
  migrateLegacyConfig?: boolean;
  repairPrefixedConfig?: boolean;
  recoverCorruptTargetStore?: boolean;
  invalidConfigNote?: string | false;
  observe?: boolean;
  measure?: ConfigSnapshotReadMeasure;
  /** Return false or reject on config drift; the preflight always unwinds owned resources. */
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
  /** CLI readiness policy evaluates the dry repaired config before any startup writes. */
  validateStartupConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  requireStateMigrationCheckpoint?: boolean;
  requireStartupMigrationCheckpoint?: boolean;
  /** Load one authoritative plugin metadata snapshot for the caller's full lifecycle. */
  preparePluginMetadataSnapshot?: boolean;
  /** Core state was proven absent before Gateway selection could create runtime files. */
  skipPristineCoreStateMigrations?: boolean;
  /** Prepared before Gateway bootstrap can create files under an otherwise pristine state root. */
  skipPristineStartupStateMigrations?: boolean;
  /** Enable migrations that may retire security-sensitive stores only during explicit repair. */
  doctorOnlyStateMigrations?: boolean;
  /** Explicit Doctor repair has imported install records and converged migration plugins. */
  migrationPluginsConverged?: true;
};

export type DoctorConfigPreflightResult = {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
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
    runWithCurrentPluginMetadata: (config: OpenClawConfig, run: () => string[]) => string[];
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
    const receipts = preflight.stateMigrationStepReceipts;
    const postSession = preflight.postSessionPluginMigration;
    const planBound = preflight.postSessionPluginMigrationPlanBound;
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
