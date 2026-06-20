import { formatCliCommand } from "../command-format.js";
import { getCoreCliCommandNames } from "./core-command-descriptors.js";
import { getSubCliEntries } from "./subcli-descriptors.js";

const EXPLICIT_COMMAND_ALIASES = new Map<string, string>([
  ["upgrade", "update"],
  ["udpate", "update"],
]);

const MAX_SUGGESTIONS = 3;

function uniqueSortedCommandNames(commands: Iterable<string>): string[] {
  return [...new Set([...commands].filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from<number>({ length: right.length + 1 });

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[right.length] ?? 0;
}

export function formatCliCommandSuggestions(input: string): string | undefined {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return undefined;
  }

  const knownCommands = uniqueSortedCommandNames([
    ...getCoreCliCommandNames(),
    ...getSubCliEntries().map((entry) => entry.name),
  ]);
  const explicitAlias = EXPLICIT_COMMAND_ALIASES.get(normalizedInput);
  if (explicitAlias && knownCommands.includes(explicitAlias)) {
    return formatCliSuggestionLines([explicitAlias]);
  }
  const suggestions = findCliCommandSuggestions(normalizedInput, knownCommands);
  if (suggestions.length === 0) {
    return undefined;
  }
  return formatCliSuggestionLines(suggestions);
}

function findCliCommandSuggestions(input: string, candidates: readonly string[]): string[] {
  const maxDistance = Math.max(1, Math.floor(input.length * 0.4));
  return candidates
    .map((command) => ({ command, distance: levenshteinDistance(input, command) }))
    .filter(({ command, distance }) => command !== input && distance <= maxDistance)
    .toSorted(
      (left, right) => left.distance - right.distance || left.command.localeCompare(right.command),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ command }) => command);
}

function formatCliSuggestionLines(suggestions: readonly string[]): string {
  const commandLines = suggestions
    .map((command) => `  ${formatCliCommand(`openclaw ${command}`)}`)
    .join("\n");
  return `Did you mean this?\n${commandLines}`;
}
