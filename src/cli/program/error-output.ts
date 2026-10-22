import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { levenshteinDistance } from "../../shared/levenshtein-distance.js";
import { getCommandPathWithRootOptions } from "../argv.js";
import { formatCliCommand } from "../command-format.js";
import { ExpectedCliError } from "../failure-output.js";
import { getCoreCliCommandNamesCore } from "./core-command-descriptors.js";
import { getSubCliCommandMetadata } from "./subcli-command-metadata.js";

const MAX_SUGGESTIONS = 3;

type FormatCliParseErrorOptions = {
  argv?: string[];
  commandPath?: string[];
  commandNames?: readonly string[];
};

function formatCliCommandSuggestions(
  input: string,
  commandPath: readonly string[] = [],
  candidates?: Iterable<string>,
): string | undefined {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return undefined;
  }

  const candidateNames =
    candidates ??
    (commandPath.length === 0
      ? [...getCoreCliCommandNamesCore(), ...getSubCliCommandMetadata().map((entry) => entry.name)]
      : []);
  const knownCommands = [...new Set([...candidateNames].filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (
    (normalizedInput === "upgrade" || normalizedInput === "udpate") &&
    knownCommands.includes("update")
  ) {
    return formatCliSuggestionLines(["update"], commandPath);
  }
  const maxDistance = Math.max(1, Math.floor(normalizedInput.length * 0.4));
  const suggestions = knownCommands
    .map((command) => ({ command, distance: levenshteinDistance(normalizedInput, command) }))
    .filter(({ command, distance }) => command !== normalizedInput && distance <= maxDistance)
    .toSorted(
      (left, right) => left.distance - right.distance || left.command.localeCompare(right.command),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ command }) => command);
  if (suggestions.length === 0) {
    return undefined;
  }
  return formatCliSuggestionLines(suggestions, commandPath);
}

function formatCliSuggestionLines(
  suggestions: readonly string[],
  commandPath: readonly string[],
): string {
  const commandPrefix = ["openclaw", ...commandPath].join(" ");
  const commandLines = suggestions
    .map((command) => `  ${formatCliCommand(`${commandPrefix} ${command}`)}`)
    .join("\n");
  return `Did you mean this?\n${commandLines}`;
}

function stripCommanderErrorPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^error:\s*/i, "")
    .trim();
}

function lines(...items: Array<string | undefined>): string {
  return `${items.filter((item): item is string => Boolean(item)).join("\n")}\n`;
}

function formatHelpHint(argv: string[] | undefined, options?: { commandPath?: string[] }): string {
  const commandPath = options?.commandPath ?? (argv ? getCommandPathWithRootOptions(argv, 2) : []);
  const command = formatCliCommand(["openclaw", ...commandPath, "--help"].join(" "));
  return `${theme.muted("Try:")} ${theme.command(command)}`;
}

function formatCliMachineOutput(humanOutput: string): string {
  const docs = `Docs: ${formatDocsLink("/cli", "docs.openclaw.ai/cli", { force: false })}`;
  return stripAnsi(humanOutput).replace(/^Docs:.*$/mu, docs);
}

function formatUnknownCommandMessage(command: string, commandPath: readonly string[]): string {
  return commandPath.length > 0
    ? `OpenClaw ${commandPath.join(" ")} has no command "${command}".`
    : `OpenClaw does not know the command "${command}".`;
}

function formatCliUnknownCommandOutput(
  command: string,
  options: FormatCliParseErrorOptions = {},
): string {
  const commandPath = options.commandPath ?? [];
  const hasParentCommand = commandPath.length > 0;
  return lines(
    theme.error(formatUnknownCommandMessage(command, commandPath)),
    formatCliCommandSuggestions(command, commandPath, options.commandNames),
    formatHelpHint(options.argv, { commandPath }),
    hasParentCommand
      ? undefined
      : `${theme.muted("Plugin command?")} ${theme.command(formatCliCommand("openclaw plugins list"))}`,
    `${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}`,
  );
}

export function createCliParseError(
  raw: string,
  options: FormatCliParseErrorOptions = {},
  errorOptions: { humanOutputWritten?: boolean } = {},
): ExpectedCliError {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    return createCliUnknownCommandError(unknownCommand[1] ?? "", options, errorOptions);
  }
  const humanOutput = formatCliParseErrorOutput(raw, options);
  return new ExpectedCliError({
    message,
    humanOutput,
    humanOutputWritten: errorOptions.humanOutputWritten,
    machineOutput: formatCliMachineOutput(humanOutput),
  });
}

export function createCliUnknownCommandError(
  command: string,
  options: FormatCliParseErrorOptions = {},
  errorOptions: { humanOutputWritten?: boolean } = {},
): ExpectedCliError {
  const commandPath = options.commandPath ?? [];
  const humanOutput = formatCliUnknownCommandOutput(command, options);
  return new ExpectedCliError({
    message: formatUnknownCommandMessage(command, commandPath),
    humanOutput,
    humanOutputWritten: errorOptions.humanOutputWritten,
    machineOutput: formatCliMachineOutput(humanOutput),
  });
}

function formatOrdinaryCliParseErrorMessage(message: string): string {
  for (const [pattern, prefix] of [
    [/^unknown option ['"`](.+?)['"`]/i, "OpenClaw does not recognize option"],
    [/^missing required argument ['"`](.+?)['"`]/i, "Missing required argument"],
    [/^required option ['"`](.+?)['"`] not specified/i, "Missing required option"],
  ] as const) {
    const match = message.match(pattern);
    if (match) {
      return `${prefix} "${match[1] ?? ""}".`;
    }
  }

  if (/^too many arguments\b/i.test(message)) {
    return "Too many arguments for this command.";
  }

  return `OpenClaw could not parse this command: ${message}`;
}

export function formatCliParseErrorOutput(
  raw: string,
  options: FormatCliParseErrorOptions = {},
): string {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    return formatCliUnknownCommandOutput(unknownCommand[1] ?? "", options);
  }

  const output = formatOrdinaryCliParseErrorMessage(message);
  return lines(
    theme.error(output),
    formatHelpHint(options.argv, { commandPath: options.commandPath }),
  );
}
