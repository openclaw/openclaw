/**
 * Auto-Update Extension for OpenClaw
 *
 * This EXTENDS the existing update command with:
 * - --auto flag (enable/disable auto-updates)
 * - --interval flag (daily/weekly/manual)
 * - --skip flag (versions to skip)
 * - --notify flag (notifications)
 *
 * This properly integrates with the existing update system at:
 * src/cli/update-cli/update-command.ts
 * src/cli/update-cli/shared.ts
 */

import fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { Option, type Command } from "commander";
import { resolveStateDir } from "../../config/paths.js";
import { logInfo, logSuccess, logWarn } from "../../logger.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";

// Auto-update config file
const AUTO_UPDATE_CONFIG = "auto-update.json";

// Get config path
export function getAutoUpdateConfigPath(): string {
  const stateDir = resolveStateDir();
  return join(stateDir, AUTO_UPDATE_CONFIG);
}

// Load config
export async function loadAutoUpdateConfig(): Promise<AutoUpdateConfig> {
  const configPath = getAutoUpdateConfigPath();
  try {
    await fs.access(configPath);
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    const error = err as Error & { code?: string };
    if (error && error.code !== "ENOENT") {
      logWarn(
        `Failed to load auto-update config: ${error.message}. Using defaults.`,
        defaultRuntime,
      );
    }
  }
  return getDefaultConfig();
}

// Get default config
function getDefaultConfig(): AutoUpdateConfig {
  return {
    enabled: false,
    interval: "weekly",
    skipVersions: [],
    notifyOnUpdate: true,
  };
}

// Save config
export async function saveAutoUpdateConfig(config: AutoUpdateConfig): Promise<void> {
  const configPath = getAutoUpdateConfigPath();
  const dir = dirname(configPath);

  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Auto-update config interface
export interface AutoUpdateConfig {
  enabled: boolean;
  interval: "daily" | "weekly" | "manual";
  skipVersions: string[];
  notifyOnUpdate: boolean;
  lastCheck?: string;
}

// Extend the existing update options type
export interface ExtendedUpdateCommandOptions {
  auto?: "on" | "off";
  interval?: "daily" | "weekly" | "manual";
  skip?: string;
  notify?: "on" | "off";
}

// Register auto-update options
export function registerAutoUpdateOptions(update: Command): void {
  update
    .addOption(
      new Option("--auto <on|off>", "Enable or disable automatic updates").choices(["on", "off"]),
    )
    .addOption(
      new Option("--interval <interval>", "Set automatic check interval").choices([
        "daily",
        "weekly",
        "manual",
      ]),
    )
    .addOption(new Option("--skip <versions>", "Comma-separated versions to skip"))
    .addOption(
      new Option("--notify <on|off>", "Enable or disable update notifications").choices([
        "on",
        "off",
      ]),
    );
}

// Handle auto-update options
export async function handleAutoUpdateOptions(
  options: ExtendedUpdateCommandOptions,
): Promise<boolean> {
  const config = await loadAutoUpdateConfig();
  let changed = false;

  if (options.auto !== undefined) {
    config.enabled = options.auto === "on";
    logSuccess(`Auto-update ${config.enabled ? "enabled" : "disabled"}`, defaultRuntime);
    changed = true;
  }

  if (options.interval !== undefined) {
    config.interval = options.interval;
    logSuccess(`Check interval set to ${config.interval}`, defaultRuntime);
    changed = true;
  }

  if (options.skip !== undefined) {
    config.skipVersions = options.skip.split(",").map((v) => v.trim());
    logSuccess(`Skip versions: ${config.skipVersions.join(", ")}`, defaultRuntime);
    changed = true;
  }

  if (options.notify !== undefined) {
    config.notifyOnUpdate = options.notify === "on";
    logSuccess(`Notifications ${config.notifyOnUpdate ? "enabled" : "disabled"}`, defaultRuntime);
    changed = true;
  }

  if (changed) {
    await saveAutoUpdateConfig(config);
  }

  return changed;
}

// Display auto-update status
export async function displayAutoUpdateStatus(): Promise<void> {
  const config = await loadAutoUpdateConfig();

  logInfo("\n" + theme.heading("Auto-Update Settings"), defaultRuntime);
  logInfo("─".repeat(40), defaultRuntime);
  logInfo(
    `  Enabled:    ${config.enabled ? theme.success("ON") : theme.warn("OFF")}`,
    defaultRuntime,
  );
  logInfo(`  Interval:  ${config.interval}`, defaultRuntime);
  logInfo(
    `  Skip:      ${config.skipVersions.length ? config.skipVersions.join(", ") : "none"}`,
    defaultRuntime,
  );
  logInfo(
    `  Notify:    ${config.notifyOnUpdate ? theme.success("ON") : theme.warn("OFF")}`,
    defaultRuntime,
  );
  logInfo("─".repeat(40) + "\n", defaultRuntime);
}

// Check if should skip version
export async function shouldSkipVersion(version: string): Promise<boolean> {
  const config = await loadAutoUpdateConfig();
  return config.skipVersions.includes(version);
}

// Record update check time
export async function recordUpdateCheck(): Promise<void> {
  const config = await loadAutoUpdateConfig();
  config.lastCheck = new Date().toISOString();
  await saveAutoUpdateConfig(config);
}

// Get next check time
export async function getNextCheckTime(): Promise<Date | null> {
  const config = await loadAutoUpdateConfig();

  if (!config.enabled || config.interval === "manual") {
    return null;
  }

  const lastCheck = config.lastCheck ? new Date(config.lastCheck) : new Date();
  const intervalMs = config.interval === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

  return new Date(lastCheck.getTime() + intervalMs);
}
