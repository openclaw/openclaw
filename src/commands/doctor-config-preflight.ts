import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";

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

/**
 * Warn if a rogue /root/.openclaw/openclaw.json exists while doctor is
 * running as a non-root user (or if doctor resolves to /root/ while
 * a real config exists elsewhere). This catches the common case where
 * `sudo openclaw doctor --fix` creates a minimal config that silently
 * overrides the gateway's actual config.
 */
async function checkForRogueRootConfig(doctorConfigDir: string): Promise<void> {
  const rogueConfigPath = "/root/.openclaw/openclaw.json";

  // If doctor is already targeting /root/, check common service-user paths
  if (path.resolve(doctorConfigDir) === path.resolve("/root/.openclaw")) {
    const serviceUserPaths = [
      "/home/node/.openclaw/openclaw.json",
      "/home/openclaw/.openclaw/openclaw.json",
    ];
    for (const candidate of serviceUserPaths) {
      try {
        await fs.access(candidate);
        note(
          [
            `Doctor is writing to /root/.openclaw/openclaw.json, but a config`,
            `also exists at ${candidate}.`,
            ``,
            `If the gateway runs as a different user (e.g. via systemd with`,
            `Environment=HOME=/home/node), the /root/ config may silently`,
            `override it and break settings like tools.elevated.`,
            ``,
            `Fix: OPENCLAW_CONFIG_PATH=${candidate} openclaw doctor --fix`,
          ].join("\n"),
          "⚠ Config path mismatch",
        );
        return;
      } catch {
        // not found
      }
    }
    return;
  }

  // If doctor is NOT targeting /root/, check if a rogue /root/ config exists
  try {
    await fs.access(rogueConfigPath);
    note(
      [
        `Found config at ${rogueConfigPath} which may override your config`,
        `at ${doctorConfigDir}/openclaw.json.`,
        ``,
        `This usually happens when "openclaw doctor --fix" was previously`,
        `run with sudo. Remove it: sudo rm ${rogueConfigPath}`,
      ].join("\n"),
      "⚠ Rogue root config detected",
    );
  } catch {
    // no rogue config, all good
  }
}

export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
};

export async function runDoctorConfigPreflight(
  options: {
    migrateState?: boolean;
    migrateLegacyConfig?: boolean;
    invalidConfigNote?: string | false;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  if (options.migrateState !== false) {
    const { autoMigrateLegacyStateDir } = await import("./doctor-state-migrations.js");
    const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
    if (stateDirResult.changes.length > 0) {
      note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
    if (stateDirResult.warnings.length > 0) {
      note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
    }
  }

  if (options.migrateLegacyConfig !== false) {
    const legacyConfigChanges = await maybeMigrateLegacyConfig();
    if (legacyConfigChanges.length > 0) {
      note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
  }

  // Check for the rogue /root/.openclaw/openclaw.json problem (#63265)
  const home = resolveHomeDir();
  if (home) {
    await checkForRogueRootConfig(path.join(home, ".openclaw"));
  }

  const snapshot = await readConfigFileSnapshot();
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

  return {
    snapshot,
    baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
  };
}
