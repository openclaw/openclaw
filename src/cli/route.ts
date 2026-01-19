import { defaultRuntime } from "../runtime.js";
import { setVerbose } from "../globals.js";
import { healthCommand } from "../commands/health.js";
import { statusCommand } from "../commands/status.js";
import { sessionsCommand } from "../commands/sessions.js";
import { agentsListCommand } from "../commands/agents.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { emitCliBanner } from "./banner.js";
import { VERSION } from "../version.js";
import {
  getCommandPath,
  getFlagValue,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
  hasHelpOrVersion,
} from "./argv.js";
import { ensureConfigReady } from "./program/config-guard.js";
import { runMemoryStatus } from "./memory-cli.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean;
}) {
  emitCliBanner(VERSION, { argv: params.argv });
  await ensureConfigReady({ runtime: defaultRuntime, commandPath: params.commandPath });
  if (params.loadPlugins) {
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_ROUTE_FIRST)) return false;
  if (hasHelpOrVersion(argv)) return false;

  const path = getCommandPath(argv, 2);
  const [primary, secondary] = path;
  if (!primary) return false;
  if (primary === "health") {
    await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: true });
    const json = hasFlag(argv, "--json");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) return false;
    setVerbose(verbose);
    await healthCommand({ json, timeoutMs, verbose }, defaultRuntime);
    return true;
  }

  if (primary === "status") {
    await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: true });
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const all = hasFlag(argv, "--all");
    const usage = hasFlag(argv, "--usage");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) return false;
    setVerbose(verbose);
    await statusCommand({ json, deep, all, usage, timeoutMs, verbose }, defaultRuntime);
    return true;
  }

  if (primary === "sessions") {
    await prepareRoutedCommand({ argv, commandPath: path });
    const json = hasFlag(argv, "--json");
    const verbose = getVerboseFlag(argv);
    const store = getFlagValue(argv, "--store");
    if (store === null) return false;
    const active = getFlagValue(argv, "--active");
    if (active === null) return false;
    setVerbose(verbose);
    await sessionsCommand({ json, store, active }, defaultRuntime);
    return true;
  }

  if (primary === "agents" && secondary === "list") {
    await prepareRoutedCommand({ argv, commandPath: path });
    const json = hasFlag(argv, "--json");
    const bindings = hasFlag(argv, "--bindings");
    await agentsListCommand({ json, bindings }, defaultRuntime);
    return true;
  }

  if (primary === "memory" && secondary === "status") {
    await prepareRoutedCommand({ argv, commandPath: path });
    const agent = getFlagValue(argv, "--agent");
    if (agent === null) return false;
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const index = hasFlag(argv, "--index");
    const verbose = hasFlag(argv, "--verbose");
    await runMemoryStatus({ agent, json, deep, index, verbose });
    return true;
  }

  return false;
}
