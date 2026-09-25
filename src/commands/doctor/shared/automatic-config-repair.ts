import { isDeepStrictEqual } from "node:util";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "../../../config/config-path-mutation.js";
import { resolveConfigSnapshotHash, transformConfigFile } from "../../../config/config.js";
import {
  getDeferredPluginMigrationConfigFacts,
  omitDeferredPluginMigrationConfig,
  preserveDeferredPluginMigrationConfig,
  setDeferredPluginMigrationConfigFacts,
} from "../../../config/deferred-plugin-migration-config.js";
import { stampConfigWriteMetadata } from "../../../config/io.meta.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../../../config/io.plugin-metadata.js";
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import { prepareConfigWriteTopology } from "../../../config/io.write-topology.js";
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { inspectShippedPluginInstallConfigRecords } from "../../../config/plugin-install-config-migration.js";
import { copyConfigResolutionFactsThroughRewrite } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectWithPlugins,
} from "../../../config/validation.js";
import { withPluginMetadataSnapshotScope } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { withDeferredPluginDoctorMigrations } from "../../../plugins/doctor-contract-registry.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  withoutPluginInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./config-flow-steps.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";
import {
  assertShippedPluginInstallConfigImportCurrent,
  importShippedPluginInstallConfigForDoctor,
  readShippedPluginInstallConfigImportRecords,
  type ShippedPluginInstallConfigImport,
} from "./plugin-registry-migration.js";

type AutomaticConfigRepairPlan = {
  config: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  changes: string[];
  writeConfig: OpenClawConfig;
};

function admitAutomaticConfigRepairSnapshot(snapshot: ConfigFileSnapshot): boolean {
  return (
    !snapshot.valid &&
    snapshot.exists &&
    snapshot.raw !== null &&
    (snapshot.includedPaths?.length ?? 0) === 0 &&
    !containsConfigIncludeDirective(snapshot.parsed)
  );
}

function prepareAutomaticConfigRepairWrite(snapshot: ConfigFileSnapshot, config: OpenClawConfig) {
  const unsetPaths = resolveManagedUnsetPathsForWrite(undefined);
  return stampConfigWriteMetadata(
    applyUnsetPathsForWrite(
      prepareConfigWriteTopology({
        snapshot,
        nextConfig: config,
        options: { persistCanonicalAgentRoster: true },
        unsetPaths,
        env: process.env,
      }).nextConfig,
      unsetPaths,
    ),
    undefined,
    undefined,
    snapshot.parsed,
  );
}

function planConfigRepair(
  snapshot: ConfigFileSnapshot,
  pluginContracts: boolean,
  installRecordOverride?: Record<string, PluginInstallRecord>,
): AutomaticConfigRepairPlan | null {
  if (!admitAutomaticConfigRepairSnapshot(snapshot)) {
    return null;
  }
  const deferredPluginMigrations = getDeferredPluginMigrationConfigFacts(snapshot.sourceConfig);
  const sourceRecords = inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig);
  if (sourceRecords.status === "invalid") {
    return null;
  }
  const projected = inheritLegacyDefaultAgentId(
    snapshot.sourceConfig,
    withoutPluginInstallRecords(snapshot.sourceConfig),
  );
  const installRecords = pluginContracts
    ? (installRecordOverride ??
      (sourceRecords.status === "valid"
        ? readShippedPluginInstallConfigImportRecords(snapshot)
        : undefined))
    : undefined;
  const withMetadata = <T>(
    config: OpenClawConfig,
    run: (metadata?: PluginMetadataSnapshot) => T,
  ): T => {
    const invoke = (metadata?: PluginMetadataSnapshot) =>
      deferredPluginMigrations
        ? withDeferredPluginDoctorMigrations(
            deferredPluginMigrations.map((pending) => pending.pluginId),
            () => run(metadata),
          )
        : run(metadata);
    if (installRecords === undefined) {
      return invoke();
    }
    const metadata = resolveConfigWidePluginMetadataSnapshot({
      config,
      installRecords,
      allowCurrent: false,
    });
    return withPluginMetadataSnapshotScope(metadata, () => invoke(metadata), { config });
  };
  const migration = withMetadata(projected, () =>
    applyLegacyDoctorMigrations(projected, {
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      context: { authoredRaw: snapshot.parsed, resolvedRaw: snapshot.sourceConfig },
      pluginContracts,
    }),
  );
  const config = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.sourceConfig,
    nextConfig: migration.next ?? projected,
    pending: deferredPluginMigrations ?? [],
  });
  if (isDeepStrictEqual(config, snapshot.sourceConfig)) {
    return null;
  }
  // Migration rebuilds the source object; retain only facts whose values survived.
  copyConfigResolutionFactsThroughRewrite(snapshot.sourceConfig, config);
  // Validate, verify, and commit one authored candidate; resolving a moved escaped
  // reference again would make successful repairs look like unexpected config drift.
  // Core-only selection must not resolve plugin migration contracts before state admission.
  const writeConfig = pluginContracts
    ? restoreDoctorConfigEnvRefs(config, prepareDoctorConfigReferenceSource(snapshot))
    : config;
  let warnings = snapshot.warnings;
  const runtimeConfig = withMetadata(config, (metadata) => {
    const validationConfig = omitDeferredPluginMigrationConfig(config, deferredPluginMigrations);
    const validated = pluginContracts
      ? validateConfigObjectWithPlugins(prepareAutomaticConfigRepairWrite(snapshot, writeConfig), {
          ...(metadata ? { pluginMetadataSnapshot: metadata } : {}),
          deferredPluginMigrations,
        })
      : { ...validateConfigObjectRaw(validationConfig), warnings };
    warnings = validated.warnings;
    const issues = (pluginContracts ? findDoctorLegacyConfigIssues : findLegacyConfigIssues)(
      validationConfig,
      validationConfig,
    );
    return validated.ok && issues.length === 0
      ? deferredPluginMigrations?.length
        ? validated.config
        : config
      : null;
  });
  if (!runtimeConfig) {
    return null;
  }
  copyConfigResolutionFactsThroughRewrite(snapshot.sourceConfig, runtimeConfig);
  setDeferredPluginMigrationConfigFacts(config, deferredPluginMigrations);
  return {
    config,
    writeConfig,
    changes: [
      ...migration.changes,
      ...(migration.warnings ?? []),
      ...(sourceRecords.status === "valid"
        ? ["Removed retired plugins.installs after preserving plugin install records."]
        : []),
    ],
    snapshot: {
      ...snapshot,
      sourceConfig: config,
      resolved: config,
      runtimeConfig,
      config: runtimeConfig,
      warnings,
      valid: true,
      issues: [],
      legacyIssues: [],
    },
  };
}

/** Admits only complete, deterministic single-file legacy migrations. */
export function planAutomaticConfigRepair(
  snapshot: ConfigFileSnapshot,
  options?: { installRecords?: Record<string, PluginInstallRecord> },
): AutomaticConfigRepairPlan | null {
  return planConfigRepair(snapshot, true, options?.installRecords);
}

/** Validate the prospective plugin contracts before their records become durable. */
export async function importAutomaticConfigRepairInstallRecords(snapshot: ConfigFileSnapshot) {
  return await importShippedPluginInstallConfigForDoctor(snapshot, {
    validateRecords: (installRecords) => {
      if (!planAutomaticConfigRepair(snapshot, { installRecords })) {
        throw new Error("Config cannot be repaired safely with the current plugin inventory.");
      }
    },
  });
}

/**
 * Backup inventory and restore overlap checks need legacy roots without changing state.
 * Full plugin-contract validation belongs to Doctor's repair plan.
 */
export function resolveLegacyConfigSnapshotForBackup(snapshot: ConfigFileSnapshot) {
  if (snapshot.valid) {
    return snapshot;
  }
  return planConfigRepair(snapshot, false)?.snapshot;
}

/** Commits a planned repair against the exact snapshot admitted by its caller. */
async function writeAutomaticConfigRepair(
  plan: AutomaticConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
  options: {
    pluginInstallConfigImport?: ShippedPluginInstallConfigImport;
    assertCurrent?: () => void;
  } = {},
): Promise<void> {
  await transformConfigFile({
    baseHash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    // Preflight can commit before the later Doctor health write. Preserve moved
    // references here, under the same snapshot/hash and read-time environment.
    transform: (_current, { snapshot: currentSnapshot }) => {
      assertShippedPluginInstallConfigImportCurrent(
        currentSnapshot,
        options.pluginInstallConfigImport,
      );
      return {
        nextConfig: plan.writeConfig,
      };
    },
    afterWrite: { mode: "none", reason: "automatic migration" },
    writeOptions: {
      expectedConfigPath: snapshot.path,
      assertCurrent: options.assertCurrent,
      auditOrigin: "doctor",
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
      // The checked receipt proves these removed records already have a durable owner.
      allowConfigSizeDrop: options.pluginInstallConfigImport !== undefined,
      // The reader retired legacy markers; persist their canonical owners in this write.
      // Planning above validates the same writer topology preparation.
      persistCanonicalAgentRoster: true,
    },
  });
}

/** Revalidate imported inventory under its owner lease before the guarded config write. */
export async function commitAutomaticConfigRepair(
  plan: AutomaticConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
  pluginInstallConfigImport?: ShippedPluginInstallConfigImport,
): Promise<void> {
  if (!pluginInstallConfigImport) {
    return await writeAutomaticConfigRepair(plan, snapshot);
  }
  const { withPluginLifecycleLease } = await import("../../../plugins/plugin-lifecycle-lease.js");
  await withPluginLifecycleLease({}, async (lease) => {
    // Cleanup since import wins: validate canonical records without replaying source JSON.
    const currentPlan = planAutomaticConfigRepair(snapshot, {
      installRecords: loadInstalledPluginIndexInstallRecordsSync(),
    });
    if (!currentPlan) {
      throw new Error("Config cannot be repaired safely with the current plugin inventory.");
    }
    await writeAutomaticConfigRepair(currentPlan, snapshot, {
      pluginInstallConfigImport,
      assertCurrent: () => lease.assertOwned(),
    });
  });
}
