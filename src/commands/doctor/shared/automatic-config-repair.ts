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
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import { prepareConfigWriteTopology } from "../../../config/io.write-topology.js";
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import { findLegacyConfigIssues, findLegacyConfigRuleIssues } from "../../../config/legacy.js";
import { copyConfigResolutionFactsThroughRewrite } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectWithPlugins,
} from "../../../config/validation.js";
import { withDeferredPluginDoctorMigrations } from "../../../plugins/doctor-contract-registry.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./config-flow-steps.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";
import { LEGACY_TALK_VOICE_CALL_INHERITANCE } from "./legacy-talk-config-normalizer.js";
import { findRetiredConfigUpgradeRequirement } from "./retired-config-formats.js";

type AutomaticConfigRepairPlan = {
  config: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  changes: string[];
  writeConfig: OpenClawConfig;
};

export function canPlanAutomaticConfigRepair(snapshot: ConfigFileSnapshot): boolean {
  return (
    snapshot.exists &&
    snapshot.raw !== null &&
    !findRetiredConfigUpgradeRequirement(
      snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
    ) &&
    (snapshot.includedPaths?.length ?? 0) === 0 &&
    !containsConfigIncludeDirective(snapshot.parsed) &&
    // Voice Call remains valid telephony config after its runtime Talk inheritance retires.
    (!snapshot.valid ||
      findLegacyConfigRuleIssues(
        snapshot.sourceConfig,
        LEGACY_TALK_VOICE_CALL_INHERITANCE.legacyRules ?? [],
        snapshot.parsed,
      ).length > 0)
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
    snapshot.parsed,
  );
}

function planConfigRepair(
  snapshot: ConfigFileSnapshot,
  pluginContracts: boolean,
): AutomaticConfigRepairPlan | null {
  if (!canPlanAutomaticConfigRepair(snapshot)) {
    return null;
  }
  const deferredPluginMigrations = getDeferredPluginMigrationConfigFacts(snapshot.sourceConfig);
  const withPluginContracts = <T>(run: () => T): T =>
    deferredPluginMigrations
      ? withDeferredPluginDoctorMigrations(
          deferredPluginMigrations.map((pending) => pending.pluginId),
          run,
        )
      : run();
  const migration = withPluginContracts(() =>
    applyLegacyDoctorMigrations(snapshot.sourceConfig, {
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      context: { authoredRaw: snapshot.parsed, resolvedRaw: snapshot.sourceConfig },
      pluginContracts,
    }),
  );
  const config = inheritLegacyDefaultAgentId(
    migration.next ?? snapshot.sourceConfig,
    preserveDeferredPluginMigrationConfig({
      sourceConfig: snapshot.sourceConfig,
      nextConfig: migration.next ?? snapshot.sourceConfig,
      pending: deferredPluginMigrations ?? [],
    }),
  );
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
  const validation = withPluginContracts(() => {
    const validationConfig = omitDeferredPluginMigrationConfig(config, deferredPluginMigrations);
    const validated = pluginContracts
      ? validateConfigObjectWithPlugins(prepareAutomaticConfigRepairWrite(snapshot, writeConfig), {
          deferredPluginMigrations,
        })
      : { ...validateConfigObjectRaw(validationConfig), warnings: snapshot.warnings };
    const issues = (pluginContracts ? findDoctorLegacyConfigIssues : findLegacyConfigIssues)(
      validationConfig,
      validationConfig,
    );
    return validated.ok && issues.length === 0 ? validated : null;
  });
  if (!validation) {
    return null;
  }
  const runtimeConfig = deferredPluginMigrations?.length ? validation.config : config;
  copyConfigResolutionFactsThroughRewrite(snapshot.sourceConfig, runtimeConfig);
  setDeferredPluginMigrationConfigFacts(config, deferredPluginMigrations);
  return {
    config,
    writeConfig,
    changes: [...migration.changes, ...(migration.warnings ?? [])],
    snapshot: {
      ...snapshot,
      sourceConfig: config,
      resolved: config,
      runtimeConfig,
      config: runtimeConfig,
      warnings: validation.warnings,
      valid: true,
      issues: [],
      legacyIssues: [],
    },
  };
}

/** Admits only complete, deterministic single-file legacy migrations. */
export function planAutomaticConfigRepair(
  snapshot: ConfigFileSnapshot,
): AutomaticConfigRepairPlan | null {
  return planConfigRepair(snapshot, true);
}

/**
 * Backup inventory and restore overlap checks need legacy roots without changing state.
 * Full plugin-contract validation belongs to Doctor's repair plan.
 */
export function resolveLegacyConfigSnapshotForBackup(snapshot: ConfigFileSnapshot) {
  return snapshot.valid ? snapshot : planConfigRepair(snapshot, false)?.snapshot;
}

/** Commits a planned repair against the exact snapshot admitted by its caller. */
export async function commitAutomaticConfigRepair(
  plan: AutomaticConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  await transformConfigFile({
    baseHash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    // Preflight can commit before the later Doctor health write. Preserve moved
    // references here, under the same snapshot/hash and read-time environment.
    transform: async (_current, { snapshot: currentSnapshot }) => {
      const { repairLegacyCronOwnersBeforeConfigWrite } = await import("../cron/legacy-owner.js");
      const changes = await repairLegacyCronOwnersBeforeConfigWrite({
        snapshot: currentSnapshot,
        nextConfig: plan.writeConfig,
      });
      if (changes.length > 0) {
        const { note } = await import("../../../../packages/terminal-core/src/note.js");
        note(changes.join("\n"), "Doctor changes");
      }
      return {
        nextConfig: plan.writeConfig,
      };
    },
    afterWrite: { mode: "none", reason: "automatic migration" },
    writeOptions: {
      expectedConfigPath: snapshot.path,
      auditOrigin: "doctor",
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
      // Doctor retired legacy markers; persist their canonical owners in this write.
      // Planning above validates the same writer topology preparation.
      persistCanonicalAgentRoster: true,
    },
  });
}
