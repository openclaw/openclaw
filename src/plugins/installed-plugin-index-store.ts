import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  INSTALLED_PLUGIN_INDEX_VERSION,
  loadInstalledPluginIndex,
  refreshInstalledPluginIndex,
  type InstalledPluginIndex,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";

export const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installed-index.json");

export type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

export type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";

export type InstalledPluginIndexStoreInspection = {
  state: InstalledPluginIndexStoreState;
  refreshReasons: readonly InstalledPluginIndexRefreshReason[];
  persisted: InstalledPluginIndex | null;
  current: InstalledPluginIndex;
};

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
    hostContractVersion: z.string(),
    compatRegistryVersion: z.string(),
    policyHash: z.string(),
    generatedAtMs: z.number(),
    refreshReason: z.string().optional(),
    plugins: z.array(InstalledPluginIndexRecordSchema),
    diagnostics: z.array(PluginDiagnosticSchema),
  })
  .passthrough();

function parseInstalledPluginIndex(value: unknown): InstalledPluginIndex | null {
  return safeParseWithSchema(InstalledPluginIndexSchema, value) as InstalledPluginIndex | null;
}

export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  const parsed = await readJsonFile<unknown>(resolveInstalledPluginIndexStorePath(options));
  return parseInstalledPluginIndex(parsed);
}

export async function writePersistedInstalledPluginIndex(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): Promise<string> {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  await writeJsonAtomic(filePath, index, {
    trailingNewline: true,
    ensureDirMode: 0o700,
    mode: 0o600,
  });
  return filePath;
}

export async function inspectPersistedInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndexStoreInspection> {
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

export async function refreshPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<InstalledPluginIndex> {
  const index = refreshInstalledPluginIndex(params);
  await writePersistedInstalledPluginIndex(index, params);
  return index;
}
