import { isTruthyEnvValue } from "../infra/env.js";
import { hasHelpOrVersion } from "./argv.js";

export function shouldRegisterPrimaryCommandOnly(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

export function shouldEagerRegisterSubcommands(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS);
}

export function shouldRegisterPrimarySubcommandOnly(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !shouldEagerRegisterSubcommands(env) && shouldRegisterPrimaryCommandOnly(argv);
}
