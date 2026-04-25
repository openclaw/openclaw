import fs from "node:fs";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  listEnabledInstalledPluginRecords,
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";

export const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
export const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";

export type PluginRegistryInstallMigrationPreflightAction =
  | "disabled"
  | "skip-existing"
  | "migrate";

export type PluginRegistryInstallMigrationPreflight = {
  action: PluginRegistryInstallMigrationPreflightAction;
  filePath: string;
  force: boolean;
  deprecationWarnings: readonly string[];
};

export type PluginRegistryInstallMigrationResult =
  | {
      status: "disabled" | "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryInstallMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryInstallMigrationPreflight;
      inspection: InstalledPluginIndexStoreInspection;
      current: InstalledPluginIndex;
    };

export type PluginRegistryInstallMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

function hasEnvFlag(env: NodeJS.ProcessEnv | undefined, key: string): boolean {
  return Boolean(env?.[key]?.trim());
}

function forceDeprecationWarning(): string {
  return `${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated and will be removed after the plugin registry migration rollout; use doctor registry repair once available.`;
}

export function preflightPluginRegistryInstallMigration(
  params: PluginRegistryInstallMigrationParams = {},
): PluginRegistryInstallMigrationPreflight {
  const env = params.env ?? process.env;
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const force = hasEnvFlag(env, FORCE_PLUGIN_REGISTRY_MIGRATION_ENV);
  const deprecationWarnings = force ? [forceDeprecationWarning()] : [];
  if (hasEnvFlag(env, DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV)) {
    return {
      action: "disabled",
      filePath,
      force,
      deprecationWarnings,
    };
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (!force && pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        force,
        deprecationWarnings,
      };
    }
  }
  return {
    action: "migrate",
    filePath,
    force,
    deprecationWarnings,
  };
}

async function readMigrationConfig(
  params: PluginRegistryInstallMigrationParams,
): Promise<OpenClawConfig> {
  if (params.config) {
    return params.config;
  }
  if (params.readConfig) {
    return await params.readConfig();
  }
  const configModule = await import("../../../config/config.js");
  return await configModule.readBestEffortConfig();
}

export async function migratePluginRegistryForInstall(
  params: PluginRegistryInstallMigrationParams = {},
): Promise<PluginRegistryInstallMigrationResult> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  if (preflight.action === "disabled") {
    return { status: "disabled", migrated: false, preflight };
  }
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const config = await readMigrationConfig(params);
  const migrationParams = {
    ...params,
    config,
  };
  const inspection = await inspectPersistedInstalledPluginIndex(migrationParams);
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
    cache: false,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
    plugins: listEnabledInstalledPluginRecords(candidateIndex, config),
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    inspection,
    current,
  };
}
