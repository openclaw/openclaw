import { formatCliCommand } from "../cli/command-format.js";
import { promptYesNo } from "../cli/prompt.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

export type PortBotOptions = {
  yes?: boolean;
  dryRun?: boolean;
};

export async function portBotCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: PortBotOptions = {},
) {
  const cfg = loadConfig();
  const detected = await detectLegacyStateMigrations({ cfg });
  if (detected.preview.length === 0) {
    runtime.log("No legacy bot state found to migrate.");
    return;
  }

  runtime.log("Legacy bot state detected:");
  for (const line of detected.preview) {
    runtime.log(line);
  }

  if (options.dryRun) {
    runtime.log(
      `Dry run only. Re-run with ${formatCliCommand("openclaw port-bot --yes")} to apply.`,
    );
    return;
  }

  let proceed = Boolean(options.yes);
  if (!proceed) {
    if (!process.stdin.isTTY) {
      runtime.error(
        `Non-interactive migration requires --yes. Re-run with ${formatCliCommand("openclaw port-bot --yes")}.`,
      );
      runtime.exit(1);
      return;
    }
    proceed = await promptYesNo("Migrate this legacy bot state now?", true);
  }
  if (!proceed) {
    runtime.log("Migration cancelled.");
    return;
  }

  const migrated = await runLegacyStateMigrations({ detected });
  if (migrated.changes.length === 0) {
    runtime.log("No migration changes were needed.");
  } else {
    runtime.log("Migration changes:");
    for (const line of migrated.changes) {
      runtime.log(`- ${line}`);
    }
  }
  if (migrated.warnings.length > 0) {
    runtime.error("Migration warnings:");
    for (const line of migrated.warnings) {
      runtime.error(`- ${line}`);
    }
  }
}
