// Friendly parse-error formatter for Commander errors and root CLI recovery hints.
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { getCommandPathWithRootOptions } from "../argv.js";
import { formatCliCommand } from "../command-format.js";

type FormatCliParseErrorOptions = {
  argv?: string[];
  /**
   * Known root command + sub-CLI root names to consider for the
   * "Did you mean this?" suggester on unknown commands (#83999). When omitted
   * the suggester is a no-op, matching legacy callers / tests.
   */
  knownCommands?: readonly string[];
};

/**
 * Explicit aliases for common terminology that doesn't fall out of edit
 * distance — e.g. `upgrade` vs `update`. Keep tight; only add entries where
 * the alias is a widely-shared synonym, not a typo cluster, so the suggestion
 * always points at a canonical command without surfacing accidental API
 * surface. See #83999.
 */
const COMMAND_ALIASES: Record<string, string> = {
  upgrade: "update",
  remove: "uninstall",
  rm: "uninstall",
  ls: "list",
  ping: "doctor",
};

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  // Two-row dynamic-programming Levenshtein — O(min(a, b)) memory, O(a*b) time.
  // Sufficient for CLI command names; openclaw doesn't ship 1000-character roots.
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[b.length] ?? 0;
}

export function suggestClosestCommand(
  unknown: string,
  known: readonly string[],
): string | undefined {
  const input = unknown.trim().toLowerCase();
  if (!input) {
    return undefined;
  }
  // Explicit alias wins over edit-distance — `openclaw upgrade` should always
  // suggest `openclaw update`, regardless of how close other commands look.
  const aliased = COMMAND_ALIASES[input];
  if (aliased && known.includes(aliased)) {
    return aliased;
  }
  // npm-style threshold: distance must be small relative to input length so we
  // don't surface a misleading suggestion for genuinely off-vocabulary inputs.
  const threshold = Math.max(1, Math.floor(input.length * 0.4));
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    if (!name) {
      continue;
    }
    const distance = levenshtein(input, name.toLowerCase());
    if (distance > threshold) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { name, distance };
    }
  }
  return best?.name;
}

function stripCommanderErrorPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^error:\s*/i, "")
    .trim();
}

function quote(value: string): string {
  return `"${value}"`;
}

function resolveHelpCommand(argv: string[] | undefined, options?: { root?: boolean }): string {
  if (options?.root || !argv) {
    return formatCliCommand("openclaw --help");
  }
  const commandPath = getCommandPathWithRootOptions(argv, 2);
  if (commandPath.length === 0) {
    return formatCliCommand("openclaw --help");
  }
  return formatCliCommand(`openclaw ${commandPath.join(" ")} --help`);
}

function lines(...items: Array<string | undefined>): string {
  return `${items.filter((item): item is string => Boolean(item)).join("\n")}\n`;
}

function formatHelpHint(argv: string[] | undefined, options?: { root?: boolean }): string {
  return `${theme.muted("Try:")} ${theme.command(resolveHelpCommand(argv, options))}`;
}

function formatDocsHint(): string {
  return `${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}`;
}

/** Convert Commander parse errors into OpenClaw-specific help and docs guidance. */
export function formatCliParseErrorOutput(
  raw: string,
  options: FormatCliParseErrorOptions = {},
): string {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    const command = unknownCommand[1] ?? "";
    const suggestion = options.knownCommands
      ? suggestClosestCommand(command, options.knownCommands)
      : undefined;
    return lines(
      theme.error(`OpenClaw does not know the command ${quote(command)}.`),
      suggestion ? theme.muted("Did you mean this?") : undefined,
      suggestion ? `  ${theme.command(formatCliCommand(`openclaw ${suggestion}`))}` : undefined,
      formatHelpHint(options.argv, { root: true }),
      `${theme.muted("Plugin command?")} ${theme.command(formatCliCommand("openclaw plugins list"))}`,
      formatDocsHint(),
    );
  }

  const unknownOption = message.match(/^unknown option ['"`](.+?)['"`]/i);
  if (unknownOption) {
    const option = unknownOption[1] ?? "";
    return lines(
      theme.error(`OpenClaw does not recognize option ${quote(option)}.`),
      formatHelpHint(options.argv),
    );
  }

  const missingArgument = message.match(/^missing required argument ['"`](.+?)['"`]/i);
  if (missingArgument) {
    const argument = missingArgument[1] ?? "";
    return lines(
      theme.error(`Missing required argument ${quote(argument)}.`),
      formatHelpHint(options.argv),
    );
  }

  const missingOption = message.match(/^required option ['"`](.+?)['"`] not specified/i);
  if (missingOption) {
    const option = missingOption[1] ?? "";
    return lines(
      theme.error(`Missing required option ${quote(option)}.`),
      formatHelpHint(options.argv),
    );
  }

  if (/^too many arguments\b/i.test(message)) {
    return lines(theme.error("Too many arguments for this command."), formatHelpHint(options.argv));
  }

  return lines(
    theme.error(`OpenClaw could not parse this command: ${message}`),
    formatHelpHint(options.argv),
  );
}
