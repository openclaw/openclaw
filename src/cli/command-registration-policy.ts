import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

const RESERVED_NON_PLUGIN_COMMAND_ROOTS = new Set(["auth", "tool", "tools"]);

/** Return true for command roots reserved by core so plugin commands cannot shadow them. */
export function isReservedNonPluginCommandRoot(primary: string | null | undefined): boolean {
  return typeof primary === "string" && RESERVED_NON_PLUGIN_COMMAND_ROOTS.has(primary);
}

/** Decide whether registration can stop after the primary command for this argv. */
export function shouldRegisterPrimaryCommandOnly(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return invocation.primary !== null || !invocation.hasHelpOrVersion;
}

/** Decide whether plugin command registration should be skipped for the current primary command. */
export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  const invocation = resolveCliArgvInvocation(params.argv);
  if (params.primary === "help") {
    return invocation.hasHelpOrVersion && invocation.commandPath.length <= 1;
  }
  if (invocation.hasHelpOrVersion) {
    return (
      !params.primary || params.hasBuiltinPrimary || isReservedNonPluginCommandRoot(params.primary)
    );
  }
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return invocation.hasHelpOrVersion;
  }
  if (isReservedNonPluginCommandRoot(params.primary)) {
    return true;
  }
  return false;
}

/** Return whether lazy subcommand registration is disabled by environment. */
export function shouldEagerRegisterSubcommands(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
}

/** Decide whether to register only the primary command and delay deeper subcommands. */
export function shouldRegisterPrimarySubcommandOnly(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !shouldEagerRegisterSubcommands(env) && shouldRegisterPrimaryCommandOnly(argv);
}
