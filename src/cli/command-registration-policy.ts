// Decides which built-in and plugin commands need registration for one CLI invocation.
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

const RESERVED_NON_PLUGIN_COMMAND_ROOTS = new Set(["auth", "tool", "tools"]);

export function isReservedNonPluginCommandRoot(primary: string | null | undefined): boolean {
  return typeof primary === "string" && RESERVED_NON_PLUGIN_COMMAND_ROOTS.has(primary);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  // Help/version invocations can skip plugin registration when built-ins can answer directly.
  const invocation = resolveCliArgvInvocation(params.argv);
  if (params.primary === "help") {
    return invocation.hasHelpOrVersion && invocation.commandPath.length <= 1;
  }
  return (
    params.hasBuiltinPrimary ||
    isReservedNonPluginCommandRoot(params.primary) ||
    (!params.primary && invocation.hasHelpOrVersion)
  );
}

export function shouldEagerRegisterSubcommands(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
}
