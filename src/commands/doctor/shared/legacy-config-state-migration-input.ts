import { inspectShippedPluginInstallConfigRecords } from "../../../config/plugin-install-config-migration.js";
import type { ConfigFileSnapshot } from "../../../config/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObjectRawWithPlugins } from "../../../config/validation.js";
import { withoutPluginInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

type StateMigrationConfigInput = {
  cfg?: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
};

export function resolveStateMigrationConfigInput(params: {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  migrationPluginsConverged?: true;
}): StateMigrationConfigInput | null {
  const pluginDoctorConfig = (params.snapshot.sourceConfig ??
    params.snapshot.config ??
    params.snapshot.parsed) as OpenClawConfig | undefined;
  if (params.snapshot.valid) {
    return params.snapshot.legacyIssues.length > 0 && pluginDoctorConfig !== undefined
      ? { cfg: params.baseConfig, pluginDoctorConfig }
      : { cfg: params.baseConfig };
  }
  const migrationSource = pluginDoctorConfig ?? params.snapshot.parsed;
  if (
    params.migrationPluginsConverged === true &&
    pluginDoctorConfig !== undefined &&
    inspectShippedPluginInstallConfigRecords(pluginDoctorConfig).status === "valid"
  ) {
    // Installed inventory now owns these records. Use a validated projection to
    // admit state migration without retiring any authored locators before it runs.
    const projected = withoutPluginInstallRecords(pluginDoctorConfig);
    const { next } = applyLegacyDoctorMigrations(projected);
    const validated = validateConfigObjectRawWithPlugins(next ?? projected);
    if (validated.ok) {
      return { cfg: validated.config, pluginDoctorConfig };
    }
  }
  if (params.snapshot.legacyIssues.length === 0 || migrationSource === undefined) {
    return null;
  }
  const migrated = migrateLegacyConfig(migrationSource);
  // Plugin config repair may retain a legacy locator until its state migration
  // completes. No config mutation must not prevent that owner from retrying.
  if (!migrated.config || migrated.partiallyValid) {
    return {
      pluginDoctorConfig: (pluginDoctorConfig ?? migrationSource) as OpenClawConfig,
    };
  }
  return {
    cfg: migrated.config,
    ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
  };
}
