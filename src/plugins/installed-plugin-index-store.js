import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { readJsonFile, readJsonFileSync, writeJsonAtomic } from "../infra/json-files.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { diffInstalledPluginIndexInvalidationReasons, INSTALLED_PLUGIN_INDEX_WARNING, INSTALLED_PLUGIN_INDEX_VERSION, INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION, loadInstalledPluginIndex, refreshInstalledPluginIndex, } from "./installed-plugin-index.js";
export const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installed-index.json");
const ContributionArraySchema = z.array(z.string());
const InstalledPluginIndexContributionsSchema = z
    .object({
    providers: ContributionArraySchema,
    channels: ContributionArraySchema,
    channelConfigs: ContributionArraySchema,
    setupProviders: ContributionArraySchema,
    cliBackends: ContributionArraySchema,
    modelCatalogProviders: ContributionArraySchema,
    commandAliases: ContributionArraySchema,
    contracts: ContributionArraySchema,
})
    .passthrough();
const InstalledPluginIndexStartupSchema = z
    .object({
    sidecar: z.boolean(),
    memory: z.boolean(),
    deferConfiguredChannelFullLoadUntilAfterListen: z.boolean(),
    agentHarnesses: ContributionArraySchema,
})
    .passthrough();
const InstalledPluginIndexRecordSchema = z
    .object({
    pluginId: z.string(),
    packageName: z.string().optional(),
    packageVersion: z.string().optional(),
    installRecord: z.record(z.string(), z.unknown()).optional(),
    installRecordHash: z.string().optional(),
    packageInstall: z.unknown().optional(),
    manifestPath: z.string(),
    manifestHash: z.string(),
    packageJson: z
        .object({
        path: z.string(),
        hash: z.string(),
    })
        .optional(),
    rootDir: z.string(),
    origin: z.string(),
    enabled: z.boolean(),
    enabledByDefault: z.boolean().optional(),
    contributions: InstalledPluginIndexContributionsSchema,
    startup: InstalledPluginIndexStartupSchema,
    compat: z.array(z.string()),
})
    .passthrough();
const PluginDiagnosticSchema = z
    .object({
    level: z.union([z.literal("warn"), z.literal("error")]),
    message: z.string(),
    pluginId: z.string().optional(),
    source: z.string().optional(),
})
    .passthrough();
const InstalledPluginIndexSchema = z
    .object({
    version: z.literal(INSTALLED_PLUGIN_INDEX_VERSION),
    warning: z.string().optional(),
    hostContractVersion: z.string(),
    compatRegistryVersion: z.string(),
    migrationVersion: z.literal(INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION),
    policyHash: z.string(),
    generatedAtMs: z.number(),
    refreshReason: z.string().optional(),
    plugins: z.array(InstalledPluginIndexRecordSchema),
    diagnostics: z.array(PluginDiagnosticSchema),
})
    .passthrough();
function parseInstalledPluginIndex(value) {
    return safeParseWithSchema(InstalledPluginIndexSchema, value);
}
export function resolveInstalledPluginIndexStorePath(options = {}) {
    if (options.filePath) {
        return options.filePath;
    }
    const env = options.env ?? process.env;
    const stateDir = options.stateDir ?? resolveStateDir(env);
    return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
export async function readPersistedInstalledPluginIndex(options = {}) {
    const parsed = await readJsonFile(resolveInstalledPluginIndexStorePath(options));
    return parseInstalledPluginIndex(parsed);
}
export function readPersistedInstalledPluginIndexSync(options = {}) {
    const parsed = readJsonFileSync(resolveInstalledPluginIndexStorePath(options));
    return parseInstalledPluginIndex(parsed);
}
export async function writePersistedInstalledPluginIndex(index, options = {}) {
    const filePath = resolveInstalledPluginIndexStorePath(options);
    await writeJsonAtomic(filePath, { ...index, warning: INSTALLED_PLUGIN_INDEX_WARNING }, {
        trailingNewline: true,
        ensureDirMode: 0o700,
        mode: 0o600,
    });
    return filePath;
}
export async function inspectPersistedInstalledPluginIndex(params = {}) {
    const persisted = await readPersistedInstalledPluginIndex(params);
    const current = loadInstalledPluginIndex(params);
    if (!persisted) {
        return {
            state: "missing",
            refreshReasons: ["missing"],
            persisted: null,
            current,
        };
    }
    const refreshReasons = diffInstalledPluginIndexInvalidationReasons(persisted, current);
    return {
        state: refreshReasons.length > 0 ? "stale" : "fresh",
        refreshReasons,
        persisted,
        current,
    };
}
export async function refreshPersistedInstalledPluginIndex(params) {
    const index = refreshInstalledPluginIndex(params);
    await writePersistedInstalledPluginIndex(index, params);
    return index;
}
