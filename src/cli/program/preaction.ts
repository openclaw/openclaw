import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { routeLogsToStderr } from "../../logging/console.js";
import type { LogLevel } from "../../logging/levels.js";
import { loggingState } from "../../logging/state.js";
import { defaultRuntime } from "../../runtime.js";
import { getCommandPathWithRootOptions, getVerboseFlag, hasHelpOrVersion } from "../argv.js";
import { emitCliBanner } from "../banner.js";
import { resolveCliName } from "../cli-name.js";
import { isCommandJsonOutputMode } from "./json-mode.js";

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
  "status",
  "health",
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set(["backup", "doctor", "completion", "secrets"]);
let configGuardModulePromise: Promise<typeof import("./config-guard.js")> | undefined;
let pluginRegistryModulePromise: Promise<typeof import("../plugin-registry.js")> | undefined;

function shouldBypassConfigGuard(commandPath: string[]): boolean {
  const [primary, secondary] = commandPath;
  if (!primary) {
    return false;
  }
  if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) {
    return true;
  }
  // config validate is the explicit validation command; let it render
  // validation failures directly without preflight guard output duplication.
  if (primary === "config" && secondary === "validate") {
    return true;
  }
  return false;
}

function loadConfigGuardModule() {
  configGuardModulePromise ??= import("./config-guard.js");
  return configGuardModulePromise;
}

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../plugin-registry.js");
  return pluginRegistryModulePromise;
}

function resolvePluginRegistryScope(commandPath: string[]): "channels" | "all" {
  return commandPath[0] === "status" || commandPath[0] === "health" ? "channels" : "all";
}

function shouldLoadPluginsForCommand(commandPath: string[], jsonOutputMode: boolean): boolean {
  const [primary, secondary] = commandPath;
  if (!primary || !PLUGIN_REQUIRED_COMMANDS.has(primary)) {
    return false;
  }
  if ((primary === "status" || primary === "health") && jsonOutputMode) {
    return false;
  }
  // Setup wizard and channels add should stay manifest-first and load selected plugins on demand.
  if (primary === "onboard" || (primary === "channels" && secondary === "add")) {
    return false;
  }
  return true;
}
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
    const commandPath = getCommandPathWithRootOptions(argv, 2);
    const jsonOutputMode = isCommandJsonOutputMode(actionCommand, argv);
    if (jsonOutputMode) {
      routeLogsToStderr();
    }
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
    if (shouldBypassConfigGuard(commandPath)) {
      return;
    }
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: defaultRuntime,
      commandPath,
      ...(jsonOutputMode ? { suppressDoctorStdout: true } : {}),
    });
    // Load plugins for commands that need channel access.
    // When --json output is active, temporarily route logs to stderr so plugin
    // registration messages don't corrupt the JSON payload on stdout.
    if (shouldLoadPluginsForCommand(commandPath, jsonOutputMode)) {
      const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
      const prev = loggingState.forceConsoleToStderr;
      if (jsonOutputMode) {
        loggingState.forceConsoleToStderr = true;
      }
      try {
        ensurePluginRegistryLoaded({ scope: resolvePluginRegistryScope(commandPath) });
      } finally {
        loggingState.forceConsoleToStderr = prev;
      }
    }
  });
}
