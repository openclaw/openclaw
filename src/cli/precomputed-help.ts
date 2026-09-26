import { getCommandPathWithRootOptions, isSimpleCommandHelpInvocation } from "./argv.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";
import type { PrecomputedSubcommandHelpName } from "./root-help-metadata.js";

type OutputPrecomputedHelpText = () => boolean;

const PRECOMPUTED_COMMAND_HELP_NAMES = new Set(["browser", "secrets", "nodes"] as const);

export type PrecomputedCommandHelpDeps = {
  outputPrecomputedBrowserHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedSecretsHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedNodesHelpText?: OutputPrecomputedHelpText;
  outputPrecomputedSubcommandHelpText?: (commandName: PrecomputedSubcommandHelpName) => boolean;
  loadRootHelpRenderOptionsForConfigSensitivePlugins?: (
    env?: NodeJS.ProcessEnv,
  ) => Promise<RootHelpRenderOptions | null>;
  env?: NodeJS.ProcessEnv;
};

const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set<PrecomputedSubcommandHelpName>([
  "config",
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
]);

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

export async function tryOutputPrecomputedCommandHelp(
  argv: string[],
  deps: PrecomputedCommandHelpDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }

  const commandName = resolvePrecomputedCommandHelpName(argv, PRECOMPUTED_COMMAND_HELP_NAMES);
  const subcommandName = commandName
    ? null
    : resolvePrecomputedCommandHelpName(argv, PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS);
  if (subcommandName) {
    const outputPrecomputedSubcommandHelpText =
      deps.outputPrecomputedSubcommandHelpText ??
      (await import("./root-help-metadata.js")).outputPrecomputedSubcommandHelpText;
    return outputPrecomputedSubcommandHelpText(subcommandName);
  }
  if (!commandName) {
    return false;
  }

  if (commandName === "nodes") {
    const loadRootHelpRenderOptionsForConfigSensitivePlugins =
      deps.loadRootHelpRenderOptionsForConfigSensitivePlugins ??
      (await import("./root-help-live-config.js"))
        .loadRootHelpRenderOptionsForConfigSensitivePlugins;
    if (await loadRootHelpRenderOptionsForConfigSensitivePlugins(env)) {
      return false;
    }
  }

  const outputName = {
    browser: "outputPrecomputedBrowserHelpText",
    secrets: "outputPrecomputedSecretsHelpText",
    nodes: "outputPrecomputedNodesHelpText",
  } as const;
  const output =
    deps[outputName[commandName]] ??
    (await import("./root-help-metadata.js"))[outputName[commandName]];
  return output();
}
