import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { type InstalledPluginIndexStoreInspection, type InstalledPluginIndexStoreOptions } from "../../../plugins/installed-plugin-index-store.js";
import { type InstalledPluginIndex, type LoadInstalledPluginIndexParams } from "../../../plugins/installed-plugin-index.js";
export declare const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
export declare const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";
export type PluginRegistryInstallMigrationPreflightAction = "disabled" | "skip-existing" | "migrate";
export type PluginRegistryInstallMigrationPreflight = {
    action: PluginRegistryInstallMigrationPreflightAction;
    filePath: string;
    force: boolean;
    deprecationWarnings: readonly string[];
};
export type PluginRegistryInstallMigrationResult = {
    status: "disabled" | "skip-existing" | "dry-run";
    migrated: false;
    preflight: PluginRegistryInstallMigrationPreflight;
} | {
    status: "migrated";
    migrated: true;
    preflight: PluginRegistryInstallMigrationPreflight;
    inspection: InstalledPluginIndexStoreInspection;
    current: InstalledPluginIndex;
};
export type PluginRegistryInstallMigrationParams = LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
};
export declare function preflightPluginRegistryInstallMigration(params?: PluginRegistryInstallMigrationParams): PluginRegistryInstallMigrationPreflight;
export declare function migratePluginRegistryForInstall(params?: PluginRegistryInstallMigrationParams): Promise<PluginRegistryInstallMigrationResult>;
