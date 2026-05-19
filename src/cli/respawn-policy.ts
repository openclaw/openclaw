import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { getCommandPositionalsWithRootOptions } from "./argv.js";

const GATEWAY_RUN_BOOLEAN_FLAGS = [
  "--allow-unconfigured",
  "--claude-cli-logs",
  "--cli-backend-logs",
  "--compact",
  "--dev",
  "--force",
  "--raw-stream",
  "--reset",
  "--tailscale-reset-on-exit",
  "--verbose",
] as const;

const GATEWAY_RUN_VALUE_FLAGS = [
  "--auth",
  "--bind",
  "--password",
  "--password-file",
  "--port",
  "--raw-stream-path",
  "--tailscale",
  "--token",
  "--ws-log",
] as const;

// Interactive setup commands use clack prompts that need exclusive raw-mode
// TTY access. Including them in the respawn skip list prevents the
// warning-suppression child process from sharing the TTY fd, which can cause
// stdin busy-wait at high CPU on Linux (Debian 6.12.63 + Node 22.22.1).
// See: https://github.com/openclaw/openclaw/issues/83560
const INTERACTIVE_TTY_COMMANDS = new Set(["tui", "terminal", "chat", "configure", "onboard"]);

function isForegroundGatewayRunArgv(argv: string[]): boolean {
  const positionals = getCommandPositionalsWithRootOptions(argv, {
    commandPath: ["gateway"],
    booleanFlags: GATEWAY_RUN_BOOLEAN_FLAGS,
    valueFlags: GATEWAY_RUN_VALUE_FLAGS,
  });
  if (!positionals) {
    return false;
  }
  return positionals.length === 0 || (positionals.length === 1 && positionals[0] === "run");
}

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.hasHelpOrVersion ||
    (invocation.primary !== null && INTERACTIVE_TTY_COMMANDS.has(invocation.primary)) ||
    (invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv))
  );
}

export function shouldSkipStartupEnvironmentRespawnForArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.hasHelpOrVersion ||
    (invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv))
  );
}
