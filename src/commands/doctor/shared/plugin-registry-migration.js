import fs from "node:fs";
import { loadPluginInstallRecords, writePersistedPluginInstallLedger, } from "../../../plugins/install-ledger-store.js";
import { inspectPersistedInstalledPluginIndex, readPersistedInstalledPluginIndexSync, resolveInstalledPluginIndexStorePath, writePersistedInstalledPluginIndex, } from "../../../plugins/installed-plugin-index-store.js";
import { listEnabledInstalledPluginRecords, loadInstalledPluginIndex, } from "../../../plugins/installed-plugin-index.js";
export const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
export const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";
function hasEnvFlag(env, key) {
    return Boolean(env?.[key]?.trim());
}
function forceDeprecationWarning() {
    return `${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated and will be removed after the plugin registry migration rollout; use doctor registry repair once available.`;
}
export function preflightPluginRegistryInstallMigration(params = {}) {
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
async function readMigrationConfig(params) {
    if (params.config) {
        return params.config;
    }
    if (params.readConfig) {
        return await params.readConfig();
    }
    const configModule = await import("../../../config/config.js");
    return await configModule.readBestEffortConfig();
}
export async function migratePluginRegistryForInstall(params = {}) {
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
    const current = {
        ...candidateIndex,
        refreshReason: "migration",
        plugins: listEnabledInstalledPluginRecords(candidateIndex, config),
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
