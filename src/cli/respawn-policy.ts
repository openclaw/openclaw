// CLI respawn skip policy for help, interactive TTY commands, and foreground Gateway runs.
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { getCommandPathWithRootOptions, getCommandPositionalsWithRootOptions } from "./argv.js";
import { isForegroundGatewayRunArgv } from "./gateway-run-argv.js";

const INTERACTIVE_TTY_COMMANDS = new Set(["tui", "terminal", "chat"]);

/** Gmail owns a shutdown grace period longer than the generic respawn wrapper allows. */
export function isForegroundGmailRunArgv(argv: string[]): boolean {
  return getCommandPathWithRootOptions(argv, 3).join(" ") === "webhooks gmail run";
}

export function isNativeHookRelayArgv(argv: string[]): boolean {
  const { commandPath } = resolveCliArgvInvocation(argv);
  return commandPath[0] === "hooks" && commandPath[1] === "relay";
}

export function shouldKeepNativeHookRelayInProcess(
  argv: string[],
  platform: NodeJS.Platform,
): boolean {
  return platform !== "win32" && isNativeHookRelayArgv(argv);
}

export function isTerminalInteractiveRespawnArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  return invocation.primary === null || INTERACTIVE_TTY_COMMANDS.has(invocation.primary);
}

export function shouldSkipRespawnForArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  const isGatewayStatus =
    invocation.commandPath.length === 2 &&
    invocation.commandPath[0] === "gateway" &&
    invocation.commandPath[1] === "status";
  const [primary, domain] = invocation.commandPath;
  const isModelRun =
    (primary === "infer" || primary === "capability") &&
    domain === "model" &&
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: [primary, domain],
      valueFlags: ["--agent"],
      maxPositionals: 1,
      mode: "command-path",
    })?.[0] === "run";
  return (
    shouldSkipStartupEnvironmentRespawnForArgv(argv, platform) ||
    (invocation.primary !== null && INTERACTIVE_TTY_COMMANDS.has(invocation.primary)) ||
    // Both commands can overlap a running Gateway or provider runtime. A parent
    // kept only to suppress warnings consumes memory for the whole operation.
    isGatewayStatus ||
    isModelRun
  );
}

/** Returns whether startup-environment respawn should be skipped without suppressing TUI respawn policy. */
export function shouldSkipStartupEnvironmentRespawnForArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.hasHelpOrVersion ||
    isForegroundGmailRunArgv(argv) ||
    // Codex owns the relay subprocess timeout. A detached startup respawn can
    // outlive the launcher when Codex kills it, stranding the relay child.
    shouldKeepNativeHookRelayInProcess(argv, platform) ||
    (invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv))
  );
}
