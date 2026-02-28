import { formatCliCommand } from "../cli/command-format.js";
import {
  type OpenClawConfig,
  isNixMode,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { ConfigFileSnapshot } from "../config/types.js";

type StartupConfigLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

function formatValidationIssues(snapshot: ConfigFileSnapshot): string {
  if (snapshot.issues.length === 0) {
    return "Unknown validation issue.";
  }
  return snapshot.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("\n");
}

function assertSnapshotValid(snapshot: ConfigFileSnapshot): asserts snapshot is ConfigFileSnapshot {
  if (snapshot.exists && !snapshot.valid) {
    const issues = formatValidationIssues(snapshot);
    throw new Error(
      `Invalid config at ${snapshot.path}.\n${issues}\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`,
    );
  }
}

async function migrateLegacyIfNeeded(snapshot: ConfigFileSnapshot, log: StartupConfigLog) {
  if (snapshot.legacyIssues.length === 0) {
    return false;
  }
  if (isNixMode) {
    throw new Error(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );
  }
  const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
  if (!migrated) {
    throw new Error(
      `Legacy config entries detected but auto-migration failed. Run "${formatCliCommand("openclaw doctor")}" to migrate.`,
    );
  }
  await writeConfigFile(migrated);
  if (changes.length > 0) {
    log.info(
      `gateway: migrated legacy config entries:\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  return true;
}

async function autoEnablePluginsIfNeeded(snapshot: ConfigFileSnapshot, log: StartupConfigLog) {
  const autoEnable = applyPluginAutoEnable({ config: snapshot.config, env: process.env });
  if (autoEnable.changes.length === 0) {
    return;
  }
  try {
    await writeConfigFile(autoEnable.config);
    log.info(
      `gateway: auto-enabled plugins:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  } catch (err) {
    log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
  }
}

export async function prepareGatewayStartupConfig(log: StartupConfigLog): Promise<OpenClawConfig> {
  let snapshot = await readConfigFileSnapshot();
  if (await migrateLegacyIfNeeded(snapshot, log)) {
    snapshot = await readConfigFileSnapshot();
  }

  assertSnapshotValid(snapshot);
  await autoEnablePluginsIfNeeded(snapshot, log);

  // Re-read so downstream startup always uses on-disk truth after migration/auto-enable attempts.
  snapshot = await readConfigFileSnapshot();
  assertSnapshotValid(snapshot);
  return snapshot.config;
}
