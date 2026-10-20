import { getCommandPathWithRootOptions, isSimpleCommandHelpInvocation } from "./argv.js";
import { PRECOMPUTED_SUBCOMMAND_HELP_NAMES } from "./precomputed-help-commands.js";

const PRECOMPUTED_COMMAND_HELP_NAMES = new Set([
  "browser",
  "secrets",
  "nodes",
  ...PRECOMPUTED_SUBCOMMAND_HELP_NAMES,
] as const);

function resolvePrecomputedCommandHelpName(argv: string[]) {
  if (!isSimpleCommandHelpInvocation(argv, PRECOMPUTED_COMMAND_HELP_NAMES)) {
    return null;
  }
  const [commandName, extra] = getCommandPathWithRootOptions(argv, 2);
  return extra === undefined
    ? ([...PRECOMPUTED_COMMAND_HELP_NAMES].find((name) => name === commandName) ?? null)
    : null;
}

export async function tryOutputPrecomputedCommandHelp(argv: string[]): Promise<boolean> {
  const env = process.env;
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }

  const commandName = resolvePrecomputedCommandHelpName(argv);
  if (!commandName) {
    return false;
  }

  if (commandName === "nodes") {
    const { loadRootHelpRenderOptionsForConfigSensitivePlugins } =
      await import("./root-help-live-config.js");
    if (await loadRootHelpRenderOptionsForConfigSensitivePlugins(env)) {
      return false;
    }
  }

  const { outputPrecomputedCommandHelpText } = await import("./root-help-metadata.js");
  return outputPrecomputedCommandHelpText(commandName);
}
