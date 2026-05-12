import type { Insertable, Selectable } from "kysely";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
  type InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

export const INSTALLED_PLUGIN_INDEX_ROW_KEY = "current";

type InstalledPluginIndexDatabase = Pick<OpenClawStateKyselyDatabase, "installed_plugin_index">;
type InstalledPluginIndexRow = Selectable<InstalledPluginIndexDatabase["installed_plugin_index"]>;
type InstalledPluginIndexInsert = Insertable<
  InstalledPluginIndexDatabase["installed_plugin_index"]
>;

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

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function rowToInstalledPluginIndex(row: InstalledPluginIndexRow): InstalledPluginIndex | null {
  return parseInstalledPluginIndex({
    version: row.version,
    ...(row.warning ? { warning: row.warning } : {}),
    hostContractVersion: row.host_contract_version,
    compatRegistryVersion: row.compat_registry_version,
    migrationVersion: row.migration_version,
    policyHash: row.policy_hash,
    generatedAtMs: row.generated_at_ms,
    ...(row.refresh_reason ? { refreshReason: row.refresh_reason } : {}),
    installRecords: parseStoredJson(row.install_records_json),
    plugins: parseStoredJson(row.plugins_json),
    diagnostics: parseStoredJson(row.diagnostics_json),
  });
}

function installedPluginIndexToRow(
  index: InstalledPluginIndex,
  updatedAtMs: number,
): InstalledPluginIndexInsert {
  return {
    index_key: INSTALLED_PLUGIN_INDEX_ROW_KEY,
    version: index.version,
    host_contract_version: index.hostContractVersion,
    compat_registry_version: index.compatRegistryVersion,
    migration_version: index.migrationVersion,
    policy_hash: index.policyHash,
    generated_at_ms: index.generatedAtMs,
    refresh_reason: index.refreshReason ?? null,
    install_records_json: JSON.stringify(index.installRecords ?? {}),
    plugins_json: JSON.stringify(index.plugins),
    diagnostics_json: JSON.stringify(index.diagnostics),
    warning: index.warning ?? null,
    updated_at_ms: updatedAtMs,
  };
}

function resolveUpdatedAtMs(now: (() => Date | number) | undefined): number {
  const value = now?.();
  if (value instanceof Date) {
    return value.getTime();
  }
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
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

export function writePersistedInstalledPluginIndexToSqliteSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions & { now?: () => Date | number } = {},
): void {
  const row = installedPluginIndexToRow(index, resolveUpdatedAtMs(options.now));
  const { index_key: _indexKey, ...updates } = row;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<InstalledPluginIndexDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("installed_plugin_index")
        .values(row)
        .onConflict((conflict) => conflict.column("index_key").doUpdateSet(updates)),
    );
  }, resolveInstalledPluginIndexStateDbOptions(options));
}

export function deletePersistedInstalledPluginIndexFromSqliteSync(
  options: InstalledPluginIndexStoreOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<InstalledPluginIndexDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("installed_plugin_index")
        .where("index_key", "=", INSTALLED_PLUGIN_INDEX_ROW_KEY),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, resolveInstalledPluginIndexStateDbOptions(options));
}

function readPersistedInstalledPluginIndexSyncFromSqlite(
  options: InstalledPluginIndexStoreOptions,
): InstalledPluginIndex | null {
  try {
    const database = openOpenClawStateDatabase(resolveInstalledPluginIndexStateDbOptions(options));
    const db = getNodeSqliteKysely<InstalledPluginIndexDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("installed_plugin_index")
        .selectAll()
        .where("index_key", "=", INSTALLED_PLUGIN_INDEX_ROW_KEY),
    );
    return row ? rowToInstalledPluginIndex(row) : null;
  } catch {
    return null;
  }
}

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  return readPersistedInstalledPluginIndexSyncFromSqlite(options);
}

export function readPersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  return readPersistedInstalledPluginIndexSyncFromSqlite(options);
}
