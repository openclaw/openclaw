// Doctor recovery of the persisted plugin registry.
import fs from "node:fs";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-record-state.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "../../../plugins/installed-plugin-index-store-path.js";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";
import {
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
} from "../../../plugins/official-external-install-records.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";

/** Backfill shipped ClawHub authority only from a catalog-bound legacy install record. */
export function migrateOfficialPluginInstallProvenance(
  records: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord> {
  const migrated = copyPluginInstallRecordMap(records);
  for (const [pluginId, record] of Object.entries(records)) {
    // Partial or conflicting authority is not a legacy shape. Local sources must
    // be reinstalled; package metadata cannot establish the missing source fact.
    if (
      record.source !== "clawhub" ||
      record.clawhubUrl !== undefined ||
      record.clawhubChannel !== undefined ||
      record.sourcePath !== undefined ||
      !resolveTrustedSourceLinkedOfficialClawHubInstall({ pluginId, record })
    ) {
      continue;
    }
    const normalized: PluginInstallRecord = {
      ...record,
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    };
    const packageName = resolveTrustedOfficialClawHubPackageName(normalized);
    if (isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: normalized })) {
      setPluginInstallRecordMapEntry(migrated, pluginId, normalized);
    }
  }
  return migrated;
}

type PluginRegistryDoctorMigrationPreflight =
  | {
      /** Migration action selected before reading or writing registry state. */
      action: "skip-existing";
      /** Persisted plugin index path that migration will inspect or write. */
      filePath: string;
      /** Authoritative pre-repair generation used to detect a real inventory change. */
      current: InstalledPluginIndex;
    }
  | {
      action: "initialize" | "migrate";
      filePath: string;
    };

type PluginRegistryDoctorMigrationResult =
  | {
      status: "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryDoctorMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryDoctorMigrationPreflight;
      current: InstalledPluginIndex;
    };

export class InvalidPluginInstallRecordStateError extends Error {}

function invalidPersistedInstallRecordMessage(filePath: string): string {
  return [
    `Persisted plugin install records are invalid at ${filePath}.`,
    "Stop the Gateway, back up this database, delete only the config_machine_state row with state_key='plugins.installedIndex' using SQLite tooling, then rerun `openclaw doctor --fix` to rebuild it.",
  ].join(" ");
}

export type PluginRegistryDoctorMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

/** Decide whether Doctor should migrate the plugin registry in this environment. */
export function preflightPluginRegistryDoctorMigration(
  params: PluginRegistryDoctorMigrationParams = {},
): PluginRegistryDoctorMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const persistedState = inspectPersistedInstalledPluginIndexInstallRecordsSync(params);
  if (persistedState.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(invalidPersistedInstallRecordMessage(filePath));
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        current: currentRegistry,
      };
    }
    // Install records without a readable index is a half-written registry, not a fresh root:
    // report it as a migration so doctor keeps warning and rebuilds from what survived.
    if (persistedState.status !== "missing") {
      return { action: "migrate", filePath };
    }
  }
  return { action: "initialize", filePath };
}

async function readMigrationConfig(
  params: PluginRegistryDoctorMigrationParams,
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

/** Rebuild Doctor's plugin registry from canonical install records when needed. */
export async function migratePluginRegistryForDoctor(
  params: PluginRegistryDoctorMigrationParams = {},
): Promise<PluginRegistryDoctorMigrationResult> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  if (params.dryRun) {
    return {
      status: preflight.action === "skip-existing" ? "skip-existing" : "dry-run",
      migrated: false,
      preflight,
    };
  }
  return await withPluginLifecycleLease(
    resolveInstalledPluginIndexStateDatabaseOptions(params),
    async () => migratePluginRegistryForDoctorWithLease(params),
  );
}

async function migratePluginRegistryForDoctorWithLease(
  params: PluginRegistryDoctorMigrationParams,
): Promise<PluginRegistryDoctorMigrationResult> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  const rawConfig = await readMigrationConfig(params);
  const config = withoutPluginInstallRecords(rawConfig);
  const installRecords = migrateOfficialPluginInstallProvenance(
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params)),
  );
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    current,
  };
}
