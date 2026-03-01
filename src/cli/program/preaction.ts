import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import { getCommandPath, getVerboseFlag, hasHelpOrVersion } from "../argv.js";
import { emitCliBanner } from "../banner.js";
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
const PLUGIN_REQUIRED_COMMANDS = new Set([
  "message",
  "channels",
  "directory",
  "agents",
  "configure",
  "onboard",
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set(["doctor", "completion", "secrets"]);

function getRootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  const root = getRootCommand(actionCommand);
  if (typeof root.getOptionValueSource !== "function") {
    return undefined;
  }
  if (root.getOptionValueSource("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = root.opts<Record<string, unknown>>().logLevel;
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
}

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) {
      return;
    }
    const commandPath = getCommandPath(argv, 2);
    const hideBanner =
      isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) ||
      commandPath[0] === "update" ||
      commandPath[0] === "completion" ||
      (commandPath[0] === "plugins" && commandPath[1] === "update");
    if (!hideBanner) {
      emitCliBanner(programVersion);
    }
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    const cliLogLevel = getCliLogLevel(actionCommand);
    if (cliLogLevel) {
      process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
    }
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    if (CONFIG_GUARD_BYPASS_COMMANDS.has(commandPath[0])) {
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
