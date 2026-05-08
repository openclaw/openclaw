import { z } from "zod";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { readOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
  type InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

export const INSTALLED_PLUGIN_INDEX_KV_SCOPE = "installed_plugin_index";
export const INSTALLED_PLUGIN_INDEX_KV_KEY = "current";

const StringArraySchema = z.array(z.string());

const InstalledPluginIndexStartupSchema = z.object({
  sidecar: z.boolean(),
  memory: z.boolean(),
  deferConfiguredChannelFullLoadUntilAfterListen: z.boolean(),
  agentHarnesses: StringArraySchema,
});

const InstalledPluginFileSignatureSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number().optional(),
});

const InstalledPluginIndexRecordSchema = z.object({
  pluginId: z.string(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  installRecord: z.record(z.string(), z.unknown()).optional(),
  installRecordHash: z.string().optional(),
  packageInstall: z.unknown().optional(),
  packageChannel: z.unknown().optional(),
  manifestPath: z.string(),
  manifestHash: z.string(),
  manifestFile: InstalledPluginFileSignatureSchema.optional(),
  format: z.string().optional(),
  bundleFormat: z.string().optional(),
  source: z.string().optional(),
  setupSource: z.string().optional(),
  packageJson: z
    .object({
      path: z.string(),
      hash: z.string(),
      fileSignature: InstalledPluginFileSignatureSchema.optional(),
    })
    .optional(),
  rootDir: z.string(),
  origin: z.string(),
  enabled: z.boolean(),
  enabledByDefault: z.boolean().optional(),
  enabledByDefaultOnPlatforms: StringArraySchema.optional(),
  syntheticAuthRefs: StringArraySchema.optional(),
  startup: InstalledPluginIndexStartupSchema,
  compat: z.array(z.string()),
});

const InstalledPluginInstallRecordSchema = z.record(z.string(), z.unknown());

const PluginDiagnosticSchema = z.object({
  level: z.union([z.literal("warn"), z.literal("error")]),
  message: z.string(),
  pluginId: z.string().optional(),
  source: z.string().optional(),
});

const InstalledPluginIndexSchema = z.object({
  version: z.literal(INSTALLED_PLUGIN_INDEX_VERSION),
  warning: z.string().optional(),
  hostContractVersion: z.string(),
  compatRegistryVersion: z.string(),
  migrationVersion: z.literal(INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION),
  policyHash: z.string(),
  generatedAtMs: z.number(),
  refreshReason: z.string().optional(),
  installRecords: z.record(z.string(), InstalledPluginInstallRecordSchema).optional(),
  plugins: z.array(InstalledPluginIndexRecordSchema),
  diagnostics: z.array(PluginDiagnosticSchema),
});

function copySafeInstallRecords(
  records: Readonly<Record<string, InstalledPluginInstallRecordInfo>> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> | undefined {
  if (!records) {
    return undefined;
  }
  const safeRecords: Record<string, InstalledPluginInstallRecordInfo> = {};
  for (const [pluginId, record] of Object.entries(records)) {
    if (isBlockedObjectKey(pluginId)) {
      continue;
    }
    safeRecords[pluginId] = record;
  }
  return safeRecords;
}

export function parseInstalledPluginIndex(value: unknown): InstalledPluginIndex | null {
  const parsed = safeParseWithSchema(InstalledPluginIndexSchema, value) as
    | (Omit<InstalledPluginIndex, "installRecords"> & {
        installRecords?: InstalledPluginIndex["installRecords"];
      })
    | null;
  if (!parsed) {
    return null;
  }
  const installRecords =
    copySafeInstallRecords(parsed.installRecords) ??
    copySafeInstallRecords(
      extractPluginInstallRecordsFromInstalledPluginIndex(parsed as InstalledPluginIndex),
    ) ??
    {};
  return {
    version: parsed.version,
    ...(parsed.warning ? { warning: parsed.warning } : {}),
    hostContractVersion: parsed.hostContractVersion,
    compatRegistryVersion: parsed.compatRegistryVersion,
    migrationVersion: parsed.migrationVersion,
    policyHash: parsed.policyHash,
    generatedAtMs: parsed.generatedAtMs,
    ...(parsed.refreshReason ? { refreshReason: parsed.refreshReason } : {}),
    installRecords,
    plugins: parsed.plugins,
    diagnostics: parsed.diagnostics,
  };
}

export function resolveInstalledPluginIndexStateDbOptions(
  options: InstalledPluginIndexStoreOptions,
): {
  env?: NodeJS.ProcessEnv;
} {
  if (!options.stateDir) {
    return options.env ? { env: options.env } : {};
  }
  return {
    env: {
      ...options.env,
      OPENCLAW_STATE_DIR: options.stateDir,
    },
  };
}

function readPersistedInstalledPluginIndexJsonSync(
  options: InstalledPluginIndexStoreOptions,
): unknown {
  try {
    return readOpenClawStateKvJson(
      INSTALLED_PLUGIN_INDEX_KV_SCOPE,
      INSTALLED_PLUGIN_INDEX_KV_KEY,
      resolveInstalledPluginIndexStateDbOptions(options),
    );
  } catch {
    return null;
  }
}

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  const parsed = readPersistedInstalledPluginIndexJsonSync(options);
  return parseInstalledPluginIndex(parsed);
}

export function readPersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  const parsed = readPersistedInstalledPluginIndexJsonSync(options);
  return parseInstalledPluginIndex(parsed);
}
