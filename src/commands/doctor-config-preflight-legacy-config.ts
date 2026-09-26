import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveFutureConfigActionBlock } from "../config/future-version-guard.js";
import {
  parseConfigJson5,
  recoverConfigFromJsonRootSuffix,
  type ConfigSnapshotReadMeasure,
} from "../config/io.js";
import { resolveCanonicalConfigPath, resolveIsConfigReadOnly } from "../config/paths.js";
import { inspectShippedPluginInstallConfigRecords } from "../config/plugin-install-config-migration.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import { resolveHomeDir } from "../utils.js";
import type { ConfigPreflightSnapshotRead } from "./config-preflight-snapshot.js";
import { shouldSkipPluginValidationForDoctorConfigPreflight } from "./doctor-config-preflight-plugin-index.js";
import { planAutomaticConfigRepair } from "./doctor/shared/automatic-config-repair.js";
import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";
import {
  prepareDoctorConfigRecoverySnapshot,
  recoverDoctorConfigFromLastKnownGood,
} from "./doctor/shared/config-recovery.js";
import {
  isRecord,
  visitAgentConfigScopes,
  visitChannelEntries,
} from "./doctor/shared/legacy-config-record-shared.js";

export function createDoctorConfigRepairPlanner(params: {
  options: DoctorConfigPreflightOptions;
  stateMigrationsRequested: boolean;
  skipLegacyParentConfigWrite: boolean;
  hasImportedPluginConfig: () => boolean;
  runWithPluginMetadataSnapshot: PluginMetadataSnapshotScopeRunner;
}) {
  const planScopedConfigRepair = (snapshot: ConfigFileSnapshot) => {
    // Read in the caller's lease cache before entering a retained Doctor metadata scope.
    const installRecords = params.hasImportedPluginConfig()
      ? loadInstalledPluginIndexInstallRecordsSync()
      : undefined;
    return params.runWithPluginMetadataSnapshot(
      { config: snapshot.sourceConfig ?? snapshot.config ?? {} },
      () => planAutomaticConfigRepair(snapshot, { installRecords }),
    );
  };
  const planAdmittedConfigRepair = (
    snapshot: ConfigFileSnapshot,
    prepared: ReturnType<typeof planAutomaticConfigRepair> = null,
  ) =>
    (params.options.repairPrefixedConfig === true ||
      (params.stateMigrationsRequested && params.options.migrateLegacyConfig !== false)) &&
    !snapshot.valid &&
    !params.skipLegacyParentConfigWrite &&
    (params.options.repairPrefixedConfig === true ||
      !shouldSkipPluginValidationForDoctorConfigPreflight()) &&
    !resolveIsConfigReadOnly(process.env) &&
    !resolveFutureConfigActionBlock({ action: "normalize legacy config", snapshot })
      ? (prepared ?? planScopedConfigRepair(snapshot))
      : null;
  return { planScopedConfigRepair, planAdmittedConfigRepair };
}

export async function migrateLegacyDoctorConfig(params: {
  enabled: boolean;
  measure: ConfigSnapshotReadMeasure;
}): Promise<void> {
  if (!params.enabled) {
    return;
  }
  const changes = await params.measure("legacy-config-migration", maybeMigrateLegacyConfig);
  if (changes.length > 0) {
    note(changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
}

function assertPreJuneConfigMigrated(config: unknown): void {
  if (!isRecord(config)) {
    return;
  }
  const retired: string[] = [];
  const checkKeys = (scope: unknown, configPath: string, keys: string[]) => {
    if (!isRecord(scope)) {
      return;
    }
    for (const key of keys) {
      if (Object.hasOwn(scope, key)) {
        retired.push(configPath ? `${configPath}.${key}` : key);
      }
    }
  };
  checkKeys(config, "", ["heartbeat"]);
  checkKeys(config.routing, "routing", ["allowFrom", "groupChat"]);
  checkKeys(config.gateway, "gateway", ["webchat"]);
  const channels = isRecord(config.channels) ? config.channels : {};
  checkKeys(channels, "channels", ["webchat"]);
  checkKeys(channels.telegram, "channels.telegram", ["requireMention"]);
  for (const channelId of ["discord", "line", "matrix", "telegram"]) {
    visitChannelEntries(config, channelId, (scope, configPath) => {
      checkKeys(scope.threadBindings, `${configPath}.threadBindings`, ["ttlHours"]);
    });
  }
  visitChannelEntries(config, "feishu", (scope, configPath) => {
    if (configPath !== "channels.feishu") {
      checkKeys(scope, configPath, ["botName"]);
    }
  });
  const session = isRecord(config.session) ? config.session : {};
  checkKeys(session.threadBindings, "session.threadBindings", ["ttlHours"]);
  visitAgentConfigScopes(config, (scope, configPath) => {
    checkKeys(
      scope,
      configPath,
      configPath === "agents.defaults"
        ? ["llm", "embeddedPi", "embeddedHarness"]
        : ["embeddedPi", "embeddedHarness"],
    );
    checkKeys(scope.sandbox, `${configPath}.sandbox`, ["perSession"]);
  });
  if (retired.length > 0) {
    throw new Error(
      `Config contains retired pre-June keys: ${retired.join(", ")}. Doctor cannot remove these settings safely. ` +
        `Install OpenClaw 2026.9.5, run "${formatCliCommand("openclaw doctor --fix")}", then upgrade to latest. ` +
        "See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.",
    );
  }
}

/** Repair active legacy bytes before considering an older backup. */
export async function prepareDoctorConfigRecovery(params: {
  enabled: boolean;
  snapshotRead: ConfigPreflightSnapshotRead;
  planRepair: (snapshot: ConfigFileSnapshot) => ReturnType<typeof planAutomaticConfigRepair>;
  readSnapshot: () => Promise<ConfigPreflightSnapshotRead>;
}) {
  let snapshotRead = params.snapshotRead;
  let snapshot = snapshotRead.snapshot;
  // Refuse before backup recovery or unknown-key cleanup can discard authored settings.
  assertPreJuneConfigMigrated(snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig);
  let activeConfigRepair: ReturnType<typeof planAutomaticConfigRepair> = null;
  const recoveryEnabled =
    params.enabled && !resolveFutureConfigActionBlock({ action: "recover config", snapshot });
  if (recoveryEnabled && snapshot.valid) {
    const recovery = await prepareDoctorConfigRecoverySnapshot(
      { configPath: snapshot.path },
      snapshot,
    );
    if (recovery) {
      await recovery.apply();
      snapshotRead = await params.readSnapshot();
      snapshot = snapshotRead.snapshot;
    }
  }
  if (recoveryEnabled && snapshot.exists && !snapshot.valid) {
    const pendingPluginInstallConfig =
      inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig).status !== "missing";
    // One retired key must not discard newer valid settings by restoring an older backup.
    activeConfigRepair =
      typeof snapshot.raw === "string" && parseConfigJson5(snapshot.raw).ok
        ? params.planRepair(snapshot)
        : null;
    let configRepaired = false;
    if (!activeConfigRepair && (await recoverConfigFromJsonRootSuffix(snapshot))) {
      note("Removed non-JSON prefix from openclaw.json.", "Config");
      configRepaired = true;
    } else if (
      !activeConfigRepair &&
      // Config preparation imports these records; backup recovery would erase its source.
      !pendingPluginInstallConfig &&
      (await recoverDoctorConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" }))
    ) {
      note(
        "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
        "Config",
      );
      configRepaired = true;
    }
    if (configRepaired) {
      snapshotRead = await params.readSnapshot();
      snapshot = snapshotRead.snapshot;
    }
    if (!snapshot.valid && typeof snapshot.raw === "string" && !parseConfigJson5(snapshot.raw).ok) {
      throw new Error(
        `Config at ${snapshot.path} is not parseable and cannot be repaired automatically. The file remains unchanged. Inspect the exact parse error with ${formatCliCommand("openclaw config validate")}, then hand-edit the file; or move it aside and run ${formatCliCommand("openclaw onboard")} to generate a fresh config.`,
      );
    }
  }
  return { snapshotRead, activeConfigRepair };
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetPath = resolveCanonicalConfigPath();
  const targetDir = path.dirname(targetPath);
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];
  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch (error) {
    // A concurrently created target wins; every other failure must remain actionable.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") {
      throw new Error(
        `Failed to migrate legacy config ${legacyPath} -> ${targetPath}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return changes;
}
