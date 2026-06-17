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
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import { findDoctorLegacyConfigIssues } from "./doctor/shared/legacy-config-issues.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";

const loadDoctorStateMigrations = createLazyRuntimeModule(
  () => import("./doctor-state-migrations.js"),
);

const loadDoctorCron = createLazyRuntimeModule(() => import("./doctor/cron/index.js"));

// A canonical openclaw.json whose only top-level keys are auto-generated skeleton metadata
// (no channels/agents/gateway bindings) is treated as "skeletal" — i.e. the user's real config
// was never migrated into it. This is the upgrade layout from #54200: ~/.openclaw/openclaw.json
// exists as a bare skeleton while the user's real legacy config still lives in moltbot.json.
const SKELETAL_CONFIG_TOP_LEVEL_KEYS = new Set(["$schema", "_meta", "meta", "update"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkeletalOpenClawConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => SKELETAL_CONFIG_TOP_LEVEL_KEYS.has(key));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True when the canonical config is present but carries only skeleton metadata. */
async function isSkeletalCanonicalConfig(targetPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(targetPath, "utf-8");
    return isSkeletalOpenClawConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

function legacyConfigBackupPath(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${targetPath}.pre-moltbot-migration.${stamp}`;
}

function legacyConfigTempPath(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${targetPath}.moltbot-migration.${stamp}.tmp`;
}

/**
 * Atomically copies a legacy config into the canonical path. When the canonical config already
 * exists (skeletal), it is renamed aside to `backupPath` first and restored on copy failure. The
 * recovered file is staged through a temp file and chmod'd 0600 so recovered credentials/keys are
 * not left world-readable. Missing-canonical recovery uses COPYFILE_EXCL so a canonical config
 * created concurrently is never clobbered.
 */
async function copyLegacyConfigIntoPlace(params: {
  backupPath?: string;
  legacyPath: string;
  targetPath: string;
}): Promise<void> {
  const tempPath = legacyConfigTempPath(params.targetPath);
  let backedUp = false;
  await fs.copyFile(params.legacyPath, tempPath);
  await fs.chmod(tempPath, 0o600).catch(() => {});
  try {
    if (params.backupPath) {
      await fs.rename(params.targetPath, params.backupPath);
      backedUp = true;
      await fs.rename(tempPath, params.targetPath);
    } else {
      await fs.copyFile(tempPath, params.targetPath, fs.constants.COPYFILE_EXCL);
      await fs.unlink(tempPath).catch(() => {});
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    if (backedUp && params.backupPath) {
      await fs.rename(params.backupPath, params.targetPath).catch(() => {});
    }
    throw error;
  }
}

/**
 * Recovers legacy config into the canonical openclaw.json.
 *
 * The retired `moltbot.json` sibling (next to ~/.openclaw/openclaw.json) is recovered ONLY under
 * `doctor --fix` (`allowSkeletalReplacement`): read-only doctor warns so users learn their real
 * config still lives in moltbot.json, but never mutates. The pre-existing `.clawdbot/clawdbot.json`
 * missing-canonical copy path is preserved unchanged. Normal runtime config resolution stays
 * canonical — moltbot.json is never re-added to the config candidate list.
 */
async function maybeMigrateLegacyConfig(options: {
  allowSkeletalReplacement: boolean;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return { changes, warnings };
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  const siblingMoltbotPath = path.join(targetDir, "moltbot.json");

  const targetExists = await pathExists(targetPath);
  const siblingMoltbotExists = await pathExists(siblingMoltbotPath);
  const targetIsSkeletal =
    targetExists && siblingMoltbotExists && (await isSkeletalCanonicalConfig(targetPath));

  // Skeletal canonical config (real config still in moltbot.json): read-only doctor warns so the
  // upgrade surfaces a recovery hint instead of a silent crash-loop; only `doctor --fix` mutates.
  if (targetIsSkeletal && !options.allowSkeletalReplacement) {
    warnings.push(
      `Found legacy sibling config at ${siblingMoltbotPath}; run openclaw doctor --fix to recover it into ${targetPath}.`,
    );
  }

  // Build the legacy candidate list. A skeletal canonical config is replaced from moltbot.json
  // only under --fix. A MISSING canonical config recovers moltbot.json (then .clawdbot) in both
  // modes, matching the existing clawdbot missing-canonical copy path.
  const legacyCandidates: string[] = [];
  if (targetIsSkeletal && options.allowSkeletalReplacement) {
    legacyCandidates.push(siblingMoltbotPath);
  }
  if (!targetExists) {
    legacyCandidates.push(siblingMoltbotPath);
    legacyCandidates.push(path.join(home, ".clawdbot", "clawdbot.json"));
  }

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    if (await pathExists(candidate)) {
      legacyPath = candidate;
      break;
    }
  }
  if (!legacyPath) {
    return { changes, warnings };
  }

  await fs.mkdir(targetDir, { recursive: true });
  const backupPath = targetExists ? legacyConfigBackupPath(targetPath) : undefined;
  try {
    await copyLegacyConfigIntoPlace({ backupPath, legacyPath, targetPath });
    if (backupPath) {
      changes.push(`Backed up skeletal config: ${targetPath} -> ${backupPath}`);
    }
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    if (targetExists) {
      warnings.push(`Skipped legacy config migration after copy failed: ${legacyPath}`);
    }
  }

  return { changes, warnings };
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

/** Returns true during updater-managed config rewrites where plugin validation may be stale. */
export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

function noteStateMigrationResult(result: {
  changes: string[];
  warnings: string[];
  notices?: string[];
}): void {
  if (result.changes.length > 0) {
    note(result.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = result.notices ?? [];
  if (notices.length > 0) {
    note(notices.map((entry) => `- ${entry}`).join("\n"), "Doctor notices");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }
}

async function runStartupUpgradeConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const { runPostCorePluginConvergence } =
    await import("../cli/update-cli/post-core-plugin-convergence.js");
  const convergence = await runPostCorePluginConvergence({
    cfg: params.cfg,
    env: params.env,
  });
  if (convergence.changes.length > 0) {
    note(convergence.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = convergence.notices ?? [];
  if (notices.length > 0) {
    note(
      notices.map((notice) => `- ${notice.message} ${notice.guidance.join(" ")}`.trim()).join("\n"),
      "Doctor notices",
    );
  }
  const warnings = convergence.warnings.map((warning) =>
    `${warning.message} ${warning.guidance.join(" ")}`.trim(),
  );
  if (warnings.length > 0) {
    note(warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return warnings;
}

function formatStartupMigrationFailure(params: { warnings: string[]; blockers: string[] }): string {
  const details = [
    ...params.warnings.map((warning) => `- ${warning}`),
    ...params.blockers.map((blocker) => `- ${blocker}`),
  ];
  return [
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    ...details,
    'Run "openclaw doctor --fix" against the mounted state/config, then restart the container.',
  ].join("\n");
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
    requireStartupMigrationCheckpoint?: boolean;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  const stateMigrations =
    options.migrateState !== false ? await loadDoctorStateMigrations() : undefined;
  const startupCheckpoint =
    options.requireStartupMigrationCheckpoint === true
      ? await import("../infra/startup-migration-checkpoint.js")
      : undefined;
  let shouldRecordStartupCheckpoint = false;
  let startupMigrationLease: StartupMigrationLease | undefined;
  let startupMigrationHeartbeat: ReturnType<typeof setInterval> | undefined;
  let startupMigrationHeartbeatError: unknown;
  const startupMigrationWarnings: string[] = [];
  const noteStartupStateMigrationResult = (result: {
    changes: string[];
    warnings: string[];
    notices?: string[];
  }) => {
    startupMigrationWarnings.push(...result.warnings);
    noteStateMigrationResult(result);
  };
  try {
    // The gateway uses this last-moment guard to ensure its prepared config did not change before
    // any automatic migration mutates state. A rejected guard skips every state migration stage.
    const stateMigrationsAllowed =
      stateMigrations === undefined ||
      options.beforeStateMigrations === undefined ||
      (await options.beforeStateMigrations());
    if (startupCheckpoint && !stateMigrationsAllowed) {
      throw new Error(
        "OpenClaw startup migrations were skipped because the selected config changed during startup; refusing to report the gateway ready. Retry startup so the new config can be validated.",
      );
    }
    if (startupCheckpoint) {
      shouldRecordStartupCheckpoint = startupCheckpoint.needsStartupMigrationCheckpoint({
        env: process.env,
      });
      startupMigrationLease = shouldRecordStartupCheckpoint
        ? startupCheckpoint.acquireStartupMigrationLease({ env: process.env })
        : undefined;
      if (startupMigrationLease) {
        startupMigrationHeartbeat = setInterval(() => {
          try {
            startupMigrationLease?.heartbeat();
          } catch (error) {
            startupMigrationHeartbeatError = error;
          }
        }, 60_000);
        startupMigrationHeartbeat.unref?.();
      }
    }
    if (stateMigrations && stateMigrationsAllowed) {
      const { autoMigrateLegacyStateDir } = stateMigrations;
      const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
      noteStartupStateMigrationResult(stateDirResult);
    }

    if (options.migrateLegacyConfig !== false) {
      const legacyConfigResult = await maybeMigrateLegacyConfig({
        allowSkeletalReplacement: options.repairPrefixedConfig === true,
      });
      if (legacyConfigResult.changes.length > 0) {
        note(legacyConfigResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
      }
      if (legacyConfigResult.warnings.length > 0) {
        note(
          legacyConfigResult.warnings.map((entry) => `- ${entry}`).join("\n"),
          "Config warnings",
        );
      }
    }

    const readOptions = {
      skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
    };
    let snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
      if (await recoverConfigFromJsonRootSuffix(snapshot)) {
        note(
          "Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.",
          "Config",
        );
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
      const {
        autoMigrateLegacyState,
        autoMigrateLegacyPluginDoctorState,
        autoMigrateLegacyTaskStateSidecars,
      } = stateMigrations;
      if (stateMigrationInput) {
        if (stateMigrationInput.cfg) {
          const { repairLegacyCronStoreWithoutPrompt } = await loadDoctorCron();
          const cronResult = await repairLegacyCronStoreWithoutPrompt({
            cfg: stateMigrationInput.cfg,
          });
          noteStartupStateMigrationResult(cronResult);
          noteStartupStateMigrationResult(
            await autoMigrateLegacyState({
              cfg: stateMigrationInput.cfg,
              ...(stateMigrationInput.pluginDoctorConfig
                ? { pluginDoctorConfig: stateMigrationInput.pluginDoctorConfig }
                : {}),
              env: process.env,
              recoverCorruptTargetStore: options.recoverCorruptTargetStore,
            }),
          );
        } else if (stateMigrationInput.pluginDoctorConfig) {
          noteStartupStateMigrationResult(
            await autoMigrateLegacyPluginDoctorState({
              config: stateMigrationInput.pluginDoctorConfig,
              env: process.env,
            }),
          );
          noteStartupStateMigrationResult(
            await autoMigrateLegacyTaskStateSidecars({ env: process.env }),
          );
        }
      } else {
        noteStartupStateMigrationResult(
          await autoMigrateLegacyTaskStateSidecars({ env: process.env }),
        );
      }
    }

    if (shouldRecordStartupCheckpoint) {
      if (startupMigrationHeartbeatError) {
        throw startupMigrationHeartbeatError instanceof Error
          ? startupMigrationHeartbeatError
          : new Error("OpenClaw startup migration lease heartbeat failed.");
      }
      const blockers =
        startupMigrationWarnings.length > 0
          ? []
          : snapshot.valid
            ? await runStartupUpgradeConvergence({ cfg: baseConfig, env: process.env })
            : ['OpenClaw config is invalid; run "openclaw doctor --fix" before startup.'];
      if (startupMigrationWarnings.length > 0 || blockers.length > 0) {
        throw new Error(
          formatStartupMigrationFailure({
            warnings: startupMigrationWarnings,
            blockers,
          }),
        );
      }
      startupCheckpoint?.recordSuccessfulStartupMigrations({
        env: process.env,
        lease: startupMigrationLease,
      });
    }

    return {
      snapshot,
      baseConfig,
    };
  } finally {
    if (startupMigrationHeartbeat) {
      clearInterval(startupMigrationHeartbeat);
    }
    startupMigrationLease?.release();
  }
}
