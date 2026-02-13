import type { Command } from "commander";
import { setVerbose, warmLoggerModule } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { getCommandPath, getVerboseFlag, hasHelpOrVersion } from "../argv.js";
import { resolveCliName } from "../cli-name.js";

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

// Commands that need channel plugins loaded
const PLUGIN_REQUIRED_COMMANDS = new Set(["message", "channels", "directory"]);

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) {
      return;
    }
    const commandPath = getCommandPath(argv, 2);
    const { isTruthyEnvValue } = await import("../../infra/env.js");
    const hideBanner =
      isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) ||
      commandPath[0] === "update" ||
      commandPath[0] === "completion" ||
      (commandPath[0] === "plugins" && commandPath[1] === "update");
    if (!hideBanner) {
      const { emitCliBanner } = await import("../banner.js");
      emitCliBanner(programVersion);
    }
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    // Pre-warm logger module so logVerbose/shouldLogVerbose can use it synchronously.
    await warmLoggerModule();
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    if (commandPath[0] === "doctor" || commandPath[0] === "completion") {
      return;
    }
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: defaultRuntime, commandPath });
    // Load plugins for commands that need channel access
    if (PLUGIN_REQUIRED_COMMANDS.has(commandPath[0])) {
      const { ensurePluginRegistryLoaded } = await import("../plugin-registry.js");
      ensurePluginRegistryLoaded();
    }
  });
}
