import { consumeRootOptionToken } from "../infra/cli-root-options.js";

export type PrecomputedSubcommandHelpName =
  | "doctor"
  | "gateway"
  | "models"
  | "plugins"
  | "sessions"
  | "tasks";

const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = new Set<PrecomputedSubcommandHelpName>([
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
  "tasks",
]);
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-V", "--version"]);

function isPrecomputedSubcommandHelpName(value: string): value is PrecomputedSubcommandHelpName {
  return PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.has(value as PrecomputedSubcommandHelpName);
}

export function resolvePrecomputedSubcommandHelpCommand(
  argv: string[],
): PrecomputedSubcommandHelpName | null {
  const args = argv.slice(2);
  let commandName: PrecomputedSubcommandHelpName | null = null;
  let sawHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    if (VERSION_FLAGS.has(arg)) {
      return null;
    }
    if (!commandName) {
      const consumed = consumeRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg.startsWith("-") || !isPrecomputedSubcommandHelpName(arg)) {
        return null;
      }
      commandName = arg;
      continue;
    }
    if (HELP_FLAGS.has(arg)) {
      sawHelp = true;
      continue;
    }
    return null;
  }

  return commandName && sawHelp ? commandName : null;
}
