import {
  PRECOMPUTED_SUBCOMMAND_HELP_NAMES,
  type PrecomputedCommandHelpName,
  type PrecomputedSubcommandHelpName,
} from "./precomputed-help-commands.js";
import { readCliStartupMetadata } from "./startup-metadata.js";

type PrecomputedHelpTextKey =
  | "rootHelpText"
  | "browserHelpText"
  | "secretsHelpText"
  | "nodesHelpText"
  | PrecomputedSubcommandHelpName;

function outputPrecomputedHelpText(key: PrecomputedHelpTextKey): boolean {
  const parsed = readCliStartupMetadata(import.meta.url);
  let value: unknown;
  if (isPrecomputedSubcommandHelpName(key)) {
    const subcommandHelpText = parsed?.subcommandHelpText;
    if (isSubcommandHelpTextRecord(subcommandHelpText)) {
      value = subcommandHelpText[key];
    }
  } else if (parsed) {
    value = parsed[key];
  }
  const helpText = typeof value === "string" && value.length > 0 ? value : null;
  if (!helpText) {
    return false;
  }
  process.stdout.write(helpText);
  return true;
}

export function outputPrecomputedRootHelpText(): boolean {
  return outputPrecomputedHelpText("rootHelpText");
}

export function outputPrecomputedCommandHelpText(commandName: PrecomputedCommandHelpName): boolean {
  const key: PrecomputedHelpTextKey = isPrecomputedSubcommandHelpName(commandName)
    ? commandName
    : `${commandName}HelpText`;
  return outputPrecomputedHelpText(key);
}

function isPrecomputedSubcommandHelpName(
  commandName: string,
): commandName is PrecomputedSubcommandHelpName {
  return PRECOMPUTED_SUBCOMMAND_HELP_NAMES.some((name) => name === commandName);
}

function isSubcommandHelpTextRecord(
  value: unknown,
): value is Partial<Record<PrecomputedSubcommandHelpName, unknown>> {
  return typeof value === "object" && value !== null;
}
