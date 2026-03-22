import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { restoreLogsToStdout, routeLogsToStderr } from "../../logging/console.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import {
  getCommandPathWithRootOptions,
  getVerboseFlag,
  hasFlag,
  hasHelpOrVersion,
} from "../argv.js";
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
  "status",
  "health",
]);
const CONFIG_GUARD_BYPASS_COMMANDS = new Set(["backup", "doctor", "completion", "secrets"]);
const JSON_PARSE_ONLY_COMMANDS = new Set(["config set"]);
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

function shouldLoadPluginsForCommand(commandPath: string[], argv: string[]): boolean {
  const [primary, secondary] = commandPath;
  if (!primary || !PLUGIN_REQUIRED_COMMANDS.has(primary)) {
    return false;
  }
  if ((primary === "status" || primary === "health") && hasFlag(argv, "--json")) {
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

function isJsonOutputMode(commandPath: string[], argv: string[]): boolean {
  if (!hasFlag(argv, "--json")) {
    return false;
  }
  const key = `${commandPath[0] ?? ""} ${commandPath[1] ?? ""}`.trim();
  if (JSON_PARSE_ONLY_COMMANDS.has(key)) {
    return false;
  }
  return true;
}

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) {
      return;
    }
    const commandPath = getCommandPathWithRootOptions(argv, 2);
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
    const isJsonMode = isJsonOutputMode(commandPath, argv);
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: defaultRuntime,
      commandPath,
      ...(isJsonMode ? { suppressDoctorStdout: true } : {}),
    });
    // Load plugins for commands that need channel access.
    // Temporarily route logs to stderr during plugin loading so that
    // plugin console.log noise does not pollute --json stdout output.
    // The routing is restored afterwards so that command handlers can
    // still emit their JSON payload via runtime.log (→ console.log).
    if (shouldLoadPluginsForCommand(commandPath, argv)) {
      if (isJsonMode) {
        routeLogsToStderr();
      }
      try {
        const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
        ensurePluginRegistryLoaded({ scope: resolvePluginRegistryScope(commandPath) });
      } finally {
        if (isJsonMode) {
          restoreLogsToStdout();
        }
      }
    }
  });
}
