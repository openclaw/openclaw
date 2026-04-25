import fs from "node:fs";
import { normalizeProviderId } from "../../../agents/provider-id.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadPluginInstallRecords,
  writePersistedPluginInstallLedger,
} from "../../../plugins/install-ledger-store.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
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
  const value = env?.[key]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
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

function normalizeRegistryReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function createMigrationPluginIdNormalizer(
  index: InstalledPluginIndex,
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    const pluginId = normalizeRegistryReference(plugin.pluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(pluginId, plugin.pluginId);
    for (const alias of [
      ...plugin.contributions.providers,
      ...plugin.contributions.channels,
      ...plugin.contributions.setupProviders,
      ...plugin.contributions.cliBackends,
      ...plugin.contributions.modelCatalogProviders,
    ]) {
      const normalizedAlias = normalizeRegistryReference(alias);
      if (normalizedAlias && !aliases.has(normalizedAlias)) {
        aliases.set(normalizedAlias, plugin.pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const normalized = normalizeRegistryReference(pluginId);
    return normalized ? (aliases.get(normalized) ?? pluginId.trim()) : pluginId.trim();
  };
}

function addPluginReference(
  references: Set<string>,
  normalizePluginId: (pluginId: string) => string,
  value: unknown,
): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizePluginId(value);
  if (normalized) {
    references.add(normalized);
  }
}

function listConfiguredChannelIds(config: OpenClawConfig): Set<string> {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return new Set();
  }
  return new Set(
    Object.keys(channels)
      .map((channelId) => normalizeRegistryReference(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
}

function listConfiguredModelProviderIds(config: OpenClawConfig): Set<string> {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return new Set();
  }
  return new Set(
    Object.keys(providers)
      .map((providerId) => normalizeProviderId(providerId))
      .filter(Boolean),
  );
}

export function listMigrationRelevantPluginRecords(params: {
  index: InstalledPluginIndex;
  config: OpenClawConfig;
  installRecords: Record<string, unknown>;
}): readonly InstalledPluginIndexRecord[] {
  const normalizePluginId = createMigrationPluginIdNormalizer(params.index);
  const referencedPluginIds = new Set<string>();
  const installedPluginIds = new Set<string>();

  for (const pluginId of Object.keys(params.installRecords)) {
    addPluginReference(installedPluginIds, normalizePluginId, pluginId);
  }

  const plugins = params.config.plugins;
  for (const pluginId of plugins?.allow ?? []) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of plugins?.deny ?? []) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of Object.keys(plugins?.entries ?? {})) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of Object.values(plugins?.slots ?? {})) {
    if (normalizeRegistryReference(pluginId) === "none") {
      continue;
    }
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }

  const configuredChannelIds = listConfiguredChannelIds(params.config);
  const configuredModelProviderIds = listConfiguredModelProviderIds(params.config);

  return params.index.plugins.filter((plugin) => {
    if (plugin.origin !== "bundled") {
      return true;
    }
    if (installedPluginIds.has(plugin.pluginId) || referencedPluginIds.has(plugin.pluginId)) {
      return true;
    }
    if (
      plugin.contributions.channels.some((channelId) =>
        configuredChannelIds.has(normalizeRegistryReference(channelId) ?? ""),
      )
    ) {
      return true;
    }
    return plugin.contributions.providers.some((providerId) =>
      configuredModelProviderIds.has(normalizeProviderId(providerId)),
    );
  });
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
  const installRecords = await loadPluginInstallRecords({ ...params, config });
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
    plugins: listMigrationRelevantPluginRecords({
      index: candidateIndex,
      config,
      installRecords,
    }),
  };
  if (Object.keys(installRecords).length > 0) {
    await writePersistedPluginInstallLedger(installRecords, params);
  }
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    inspection,
    current,
  };
}
