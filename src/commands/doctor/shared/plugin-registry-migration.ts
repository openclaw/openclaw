import fs from "node:fs";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-record-state.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
} from "../../../plugins/official-external-install-records.js";

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

export class InvalidPluginInstallRecordStateError extends Error {}

export function preflightPluginRegistryDoctorMigration(
  params: InstalledPluginIndexStoreOptions = {},
): PluginRegistryDoctorMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const persistedState = inspectPersistedInstalledPluginIndexInstallRecordsSync(params);
  if (persistedState.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(
      `Persisted plugin install records are invalid at ${filePath}. Stop the Gateway, back up this database, delete only the config_machine_state row with state_key='plugins.installedIndex' using SQLite tooling, then rerun \`openclaw doctor --fix\` to rebuild it.`,
    );
  }
  if (fs.existsSync(filePath)) {
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
