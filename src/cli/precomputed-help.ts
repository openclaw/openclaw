import { getCommandPathWithRootOptions, isSimpleCommandHelpInvocation } from "./argv.js";
import { PRECOMPUTED_SUBCOMMAND_HELP_NAMES } from "./precomputed-help-commands.js";

const PRECOMPUTED_COMMAND_HELP_NAMES = new Set(["browser", "secrets", "nodes"] as const);

const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set(PRECOMPUTED_SUBCOMMAND_HELP_NAMES);

function resolvePrecomputedCommandHelpName<T extends string>(
  argv: string[],
  commandNames: ReadonlySet<T>,
): T | null {
  if (!isSimpleCommandHelpInvocation(argv, commandNames)) {
    return null;
  }
  const [commandName, extra] = getCommandPathWithRootOptions(argv, 2);
  return extra === undefined
    ? ([...commandNames].find((name) => name === commandName) ?? null)
    : null;
}

export async function tryOutputPrecomputedCommandHelp(argv: string[]): Promise<boolean> {
  const env = process.env;
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }

  const commandName = resolvePrecomputedCommandHelpName(argv, PRECOMPUTED_COMMAND_HELP_NAMES);
  const subcommandName = commandName
    ? null
    : resolvePrecomputedCommandHelpName(argv, PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS);
  if (subcommandName) {
    const { outputPrecomputedSubcommandHelpText } = await import("./root-help-metadata.js");
    return outputPrecomputedSubcommandHelpText(subcommandName);
  }
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

  const outputName = {
    browser: "outputPrecomputedBrowserHelpText",
    secrets: "outputPrecomputedSecretsHelpText",
    nodes: "outputPrecomputedNodesHelpText",
  } as const;
  const output = (await import("./root-help-metadata.js"))[outputName[commandName]];
  return output();
}
