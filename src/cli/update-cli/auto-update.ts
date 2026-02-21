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

import { existsSync, mkdirSync } from "fs";
import fs from "node:fs/promises";
import { join } from "path";
import chalk from "chalk";
import { Option, type Command } from "commander";
import { resolveStateDir } from "../../config/paths.js";

// Auto-update config file
const AUTO_UPDATE_CONFIG = "auto-update.json";

// Get config path
function getAutoUpdateConfigPath(): string {
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
  } catch {
    // Ignore errors
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
  const dir = join(configPath, "..");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
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
    console.log(chalk.green("✓ ") + `Auto-update ${config.enabled ? "enabled" : "disabled"}`);
    changed = true;
  }

  if (options.interval !== undefined) {
    config.interval = options.interval;
    console.log(chalk.green("✓ ") + `Check interval set to ${config.interval}`);
    changed = true;
  }

  if (options.skip !== undefined) {
    config.skipVersions = options.skip.split(",").map((v) => v.trim());
    console.log(chalk.green("✓ ") + `Skip versions: ${config.skipVersions.join(", ")}`);
    changed = true;
  }

  if (options.notify !== undefined) {
    config.notifyOnUpdate = options.notify === "on";
    console.log(
      chalk.green("✓ ") + `Notifications ${config.notifyOnUpdate ? "enabled" : "disabled"}`,
    );
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

  console.log("\n" + chalk.bold("Auto-Update Settings"));
  console.log("─".repeat(40));
  console.log(`  Enabled:    ${config.enabled ? chalk.green("ON") : chalk.yellow("OFF")}`);
  console.log(`  Interval:  ${config.interval}`);
  console.log(
    `  Skip:      ${config.skipVersions.length ? config.skipVersions.join(", ") : "none"}`,
  );
  console.log(`  Notify:    ${config.notifyOnUpdate ? chalk.green("ON") : chalk.yellow("OFF")}`);
  console.log("─".repeat(40) + "\n");
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
