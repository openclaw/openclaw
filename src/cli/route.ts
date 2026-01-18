import { defaultRuntime } from "../runtime.js";
import { setVerbose } from "../globals.js";
import { healthCommand } from "../commands/health.js";
import { statusCommand } from "../commands/status.js";
import { sessionsCommand } from "../commands/sessions.js";
import { agentsListCommand } from "../commands/agents.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { hasHelpOrVersion, getCommandPath } from "./argv.js";
import { parsePositiveIntOrUndefined } from "./program/helpers.js";
import { ensureConfigReady } from "./program/config-guard.js";
import { runMemoryStatus } from "./memory-cli.js";

const getFlagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
};

const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_ROUTE_FIRST)) return false;
  if (hasHelpOrVersion(argv)) return false;

  const path = getCommandPath(argv, 2);
  const [primary, secondary] = path;
  if (!primary) return false;

  if (primary === "health") {
    await ensureConfigReady({ runtime: defaultRuntime, migrateState: false });
    ensurePluginRegistryLoaded();
    const json = hasFlag(argv, "--json");
    const verbose = hasFlag(argv, "--verbose") || hasFlag(argv, "--debug");
    const timeout = getFlagValue(argv, "--timeout");
    const timeoutMs = parsePositiveIntOrUndefined(timeout);
    setVerbose(verbose);
    await healthCommand({ json, timeoutMs, verbose }, defaultRuntime);
    return true;
  }

  if (primary === "status") {
    await ensureConfigReady({ runtime: defaultRuntime, migrateState: false });
    ensurePluginRegistryLoaded();
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const all = hasFlag(argv, "--all");
    const usage = hasFlag(argv, "--usage");
    const verbose = hasFlag(argv, "--verbose") || hasFlag(argv, "--debug");
    const timeout = getFlagValue(argv, "--timeout");
    const timeoutMs = parsePositiveIntOrUndefined(timeout);
    setVerbose(verbose);
    await statusCommand({ json, deep, all, usage, timeoutMs, verbose }, defaultRuntime);
    return true;
  }

  if (primary === "sessions") {
    await ensureConfigReady({ runtime: defaultRuntime, migrateState: false });
    const json = hasFlag(argv, "--json");
    const verbose = hasFlag(argv, "--verbose");
    const store = getFlagValue(argv, "--store");
    const active = getFlagValue(argv, "--active");
    setVerbose(verbose);
    await sessionsCommand({ json, store, active }, defaultRuntime);
    return true;
  }

  if (primary === "agents" && secondary === "list") {
    await ensureConfigReady({ runtime: defaultRuntime, migrateState: true });
    const json = hasFlag(argv, "--json");
    const bindings = hasFlag(argv, "--bindings");
    await agentsListCommand({ json, bindings }, defaultRuntime);
    return true;
  }

  if (primary === "memory" && secondary === "status") {
    const agent = getFlagValue(argv, "--agent");
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const index = hasFlag(argv, "--index");
    const verbose = hasFlag(argv, "--verbose");
    await runMemoryStatus({ agent, json, deep, index, verbose });
    return true;
  }

  return false;
}
