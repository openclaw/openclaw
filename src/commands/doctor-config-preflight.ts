/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { ConfigFileSnapshot, LegacyConfigIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import { findDoctorLegacyConfigIssues } from "./doctor/shared/legacy-config-issues.js";
import { migrateLegacyConfig } from "./doctor/shared/legacy-config-migrate.js";

type DoctorStateMigrationsModule = typeof import("./doctor-state-migrations.js");
type DoctorCronModule = typeof import("./doctor/cron/index.js");

type StateMigrationConfigInput = {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
};

let doctorStateMigrationsPromise: Promise<DoctorStateMigrationsModule> | null = null;
let doctorCronPromise: Promise<DoctorCronModule> | null = null;

function loadDoctorStateMigrations(): Promise<DoctorStateMigrationsModule> {
  doctorStateMigrationsPromise ??= import("./doctor-state-migrations.js");
  return doctorStateMigrationsPromise;
}

function loadDoctorCron(): Promise<DoctorCronModule> {
  doctorCronPromise ??= import("./doctor/cron/index.js");
  return doctorCronPromise;
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
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
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
};

function collectDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): LegacyConfigIssue[] {
  if (!snapshot.exists) {
    return [];
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const sourceRaw = snapshot.parsed ?? resolvedRaw;
  return findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
}

function addDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  const legacyIssues = collectDoctorLegacyIssues(snapshot);
  if (legacyIssues.length === 0) {
    return snapshot;
  }
  return { ...snapshot, legacyIssues };
}

function resolveStateMigrationConfigInput(params: {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
}): StateMigrationConfigInput | null {
  const pluginDoctorConfig = (params.snapshot.sourceConfig ??
    params.snapshot.config ??
    params.snapshot.parsed) as OpenClawConfig | undefined;
  if (params.snapshot.valid) {
    return params.snapshot.legacyIssues.length > 0 && pluginDoctorConfig !== undefined
      ? { cfg: params.baseConfig, pluginDoctorConfig }
      : { cfg: params.baseConfig };
  }
  const migrationSource = pluginDoctorConfig ?? params.snapshot.parsed;
  if (params.snapshot.legacyIssues.length === 0 || migrationSource === undefined) {
    return null;
  }
  const migrated = migrateLegacyConfig(migrationSource);
  if (!migrated.config || migrated.partiallyValid) {
    return null;
  }
  return {
    cfg: migrated.config,
    ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
  };
}

/** Returns true during updater-managed config rewrites where plugin validation may be stale. */
export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

function noteStateMigrationResult(result: { changes: string[]; warnings: string[] }): void {
  if (result.changes.length > 0) {
    note(result.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }
}

/**
 * Runs early doctor config checks before the main config repair flow.
 *
 * It may migrate legacy state/config paths, recover corrupt target config when requested, and
 * returns the best-effort config snapshot used by later doctor checks.
 */
export async function runDoctorConfigPreflight(
  options: {
    migrateState?: boolean;
    migrateLegacyConfig?: boolean;
    repairPrefixedConfig?: boolean;
    recoverCorruptTargetStore?: boolean;
    invalidConfigNote?: string | false;
    beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  const stateMigrations =
    options.migrateState !== false ? await loadDoctorStateMigrations() : undefined;
  // The gateway uses this last-moment guard to ensure its prepared config did not change before
  // any automatic migration mutates state. A rejected guard skips every state migration stage.
  const stateMigrationsAllowed =
    stateMigrations === undefined ||
    options.beforeStateMigrations === undefined ||
    (await options.beforeStateMigrations());
  if (stateMigrations && stateMigrationsAllowed) {
    const { autoMigrateLegacyStateDir } = stateMigrations;
    const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
    noteStateMigrationResult(stateDirResult);
  }

  if (options.migrateLegacyConfig !== false) {
    const legacyConfigChanges = await maybeMigrateLegacyConfig();
    if (legacyConfigChanges.length > 0) {
      note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
  }

  const readOptions = {
    skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
  };
  let snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
  if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
    if (await recoverConfigFromJsonRootSuffix(snapshot)) {
      note("Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.", "Config");
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    } else if (
      await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" })
    ) {
      note(
        "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
        "Config",
      );
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    }
  }
  const invalidConfigNote =
    options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
  if (
    invalidConfigNote &&
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note(invalidConfigNote, "Config");
    noteIncludeConfinementWarning(snapshot);
  }

  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
  }

  const baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
  const stateMigrationInput = resolveStateMigrationConfigInput({ snapshot, baseConfig });
  const configStateMigrationsAllowed =
    stateMigrations !== undefined &&
    stateMigrationsAllowed &&
    (options.beforeStateMigrations === undefined ||
      (await options.beforeStateMigrations(snapshot)));
  if (stateMigrations && configStateMigrationsAllowed) {
    const { autoMigrateLegacyState, autoMigrateLegacyTaskStateSidecars } = stateMigrations;
    if (stateMigrationInput) {
      const { repairLegacyCronStoreWithoutPrompt } = await loadDoctorCron();
      const cronResult = await repairLegacyCronStoreWithoutPrompt({ cfg: stateMigrationInput.cfg });
      noteStateMigrationResult(cronResult);
      noteStateMigrationResult(
        await autoMigrateLegacyState({
          cfg: stateMigrationInput.cfg,
          ...(stateMigrationInput.pluginDoctorConfig
            ? { pluginDoctorConfig: stateMigrationInput.pluginDoctorConfig }
            : {}),
          env: process.env,
          recoverCorruptTargetStore: options.recoverCorruptTargetStore,
        }),
      );
    } else {
      noteStateMigrationResult(await autoMigrateLegacyTaskStateSidecars({ env: process.env }));
    }
  }

  return {
    snapshot,
    baseConfig,
  };
}
