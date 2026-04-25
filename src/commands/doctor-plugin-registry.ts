import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  readPersistedPluginInstallLedger,
  resolvePluginInstallLedgerStorePath,
  withoutPluginInstallRecords,
  writePersistedPluginInstallLedger,
  type PluginInstallLedgerStoreOptions,
} from "../plugins/install-ledger-store.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> &
  PluginInstallLedgerStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

type LegacyInstallLedgerMigrationResult = {
  config: OpenClawConfig;
  migrated: boolean;
  recordCount: number;
};

function countRecords(records: Record<string, unknown> | undefined): number {
  return Object.keys(records ?? {}).length;
}

function mergeInstallRecords(
  legacyRecords: Record<string, PluginInstallRecord>,
  ledgerRecords: Record<string, PluginInstallRecord> | undefined,
): Record<string, PluginInstallRecord> {
  return {
    ...legacyRecords,
    ...(ledgerRecords ?? {}),
  };
}

async function maybeMigrateLegacyInstallLedger(
  params: PluginRegistryDoctorRepairParams,
): Promise<LegacyInstallLedgerMigrationResult> {
  const legacyRecords = params.config.plugins?.installs;
  const legacyCount = countRecords(legacyRecords);
  if (!legacyRecords || legacyCount === 0) {
    return {
      config: params.config,
      migrated: false,
      recordCount: 0,
    };
  }

  const ledgerPath = resolvePluginInstallLedgerStorePath(params);
  if (!params.prompter.shouldRepair) {
    note(
      [
        `Legacy plugin install records still live in config at \`plugins.installs\`.`,
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to move them to ${shortenHomePath(ledgerPath)} and remove the config copy.`,
      ].join("\n"),
      "Plugin registry",
    );
    return {
      config: params.config,
      migrated: false,
      recordCount: legacyCount,
    };
  }

  const existingLedger = await readPersistedPluginInstallLedger(params);
  const nextRecords = mergeInstallRecords(legacyRecords, existingLedger?.records);
  await writePersistedPluginInstallLedger(nextRecords, params);
  const nextConfig = withoutPluginInstallRecords(params.config);
  note(
    [
      `Moved ${legacyCount} legacy plugin install record${legacyCount === 1 ? "" : "s"} from config to ${shortenHomePath(ledgerPath)}.`,
      "Removed the legacy `plugins.installs` config copy.",
    ].join("\n"),
    "Plugin registry",
  );
  return {
    config: nextConfig,
    migrated: true,
    recordCount: legacyCount,
  };
}

export async function maybeRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
): Promise<OpenClawConfig> {
  let nextConfig = params.config;
  const ledgerMigration = await maybeMigrateLegacyInstallLedger(params);
  nextConfig = ledgerMigration.config;

  const migrationParams = {
    ...params,
    config: nextConfig,
  };
  const preflight = preflightPluginRegistryInstallMigration(migrationParams);
  for (const warning of preflight.deprecationWarnings) {
    note(warning, "Plugin registry");
  }
  if (preflight.action === "disabled") {
    note(
      `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`,
      "Plugin registry",
    );
    return nextConfig;
  }

  if (!params.prompter.shouldRepair) {
    if (preflight.action === "migrate") {
      note(
        [
          "Persisted plugin registry is missing or stale.",
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    return nextConfig;
  }

  if (preflight.action === "migrate") {
    const result = await migratePluginRegistryForInstall(migrationParams);
    if (result.migrated) {
      const total = result.current.plugins.length;
      const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
      note(
        `Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`,
        "Plugin registry",
      );
    }
    return nextConfig;
  }

  if (ledgerMigration.migrated) {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
    });
    const total = index.plugins.length;
    const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
    note(
      `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
      "Plugin registry",
    );
  }

  return nextConfig;
}
