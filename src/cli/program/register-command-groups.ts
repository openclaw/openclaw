import type { Command, Option } from "commander";
import { buildParseArgv } from "../argv.js";
import { getCliPluginInvocationResources } from "../runtime-cleanup-scope.js";
import { getCommandHierarchy, getRootCommand, removeCommandByName } from "./command-tree.js";
import { markCommanderLazyCommand } from "./commander-parse-facts.js";

function findOption(command: Command, token: string): Option | undefined {
  const equalsIndex = token.indexOf("=");
  const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  const exactOption = command.options.find(
    (candidate) =>
      (candidate.short === flag || candidate.long === flag) &&
      (equalsIndex === -1 || candidate.required || candidate.optional),
  );
  if (exactOption || !token.startsWith("-") || token.startsWith("--") || token.length <= 2) {
    return exactOption;
  }
  // Once a child claims a short group, preserve its unknown suffix for Commander.
  let claimedOption: Option | undefined;
  for (let index = 1; index < token.length; index += 1) {
    const option = command.options.find((candidate) => candidate.short === `-${token[index]}`);
    if (!option) {
      return claimedOption;
    }
    claimedOption ??= option;
    if (option.required || option.optional || index === token.length - 1) {
      return option;
    }
  }
  return undefined;
}

function findNearestOption(commands: readonly Command[], token: string): Option | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    const option = command ? findOption(command, token) : undefined;
    if (option) {
      return option;
    }
  }
  return undefined;
}

function matchesCommandName(command: Command, token: string): boolean {
  return command.name() === token || command.aliases().includes(token);
}

// Returns 0 for a missing required value, otherwise the number of consumed tokens.
function optionTokenCount(option: Option, argv: readonly string[], index: number): number {
  const token = argv[index] ?? "";
  const shortFlagIndex =
    option.short !== undefined && !token.startsWith("--")
      ? token.indexOf(option.short.slice(1), 1)
      : -1;
  const hasAttachedShortValue = shortFlagIndex !== -1 && shortFlagIndex < token.length - 1;
  if (token.includes("=") || hasAttachedShortValue || (!option.required && !option.optional)) {
    return 1;
  }
  const next = argv[index + 1];
  if (option.required) {
    return next === undefined ? 0 : 2;
  }
  const optionalValue = next && (!next.startsWith("-") || /^-\d/.test(next));
  return optionalValue ? 2 : 1;
}

function findCommandPathEnd(argv: readonly string[], command: Command): number {
  const path = getCommandHierarchy(command)
    .slice(1)
    .filter((current) => current.name());
  const root = path[0]?.parent;
  if (!root) {
    return -1;
  }
  const selectedCommands = [root];
  let pathIndex = 0;
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const option = findNearestOption(selectedCommands, token);
    if (option) {
      const count = optionTokenCount(option, argv, index);
      if (count === 0) {
        return -1;
      }
      index += count - 1;
      continue;
    }
    const nextCommand = path[pathIndex];
    if (!nextCommand || !matchesCommandName(nextCommand, token)) {
      return -1;
    }
    selectedCommands.push(nextCommand);
    pathIndex += 1;
    if (pathIndex === path.length) {
      return index + 1;
    }
  }
  return -1;
}

export type CommandGroupPlaceholder = {
  name: string;
  description: string;
  hidden?: boolean;
  options?: readonly CommandGroupPlaceholderOption[];
};

type CommandGroupPlaceholderOption = {
  flags: string;
  description: string;
};

export type CommandGroupEntry = {
  placeholders: readonly CommandGroupPlaceholder[];
  names?: readonly string[];
  register: (program: Command) => Promise<void> | void;
};

export function getCommandGroupNames(entry: CommandGroupEntry): readonly string[] {
  return entry.names ?? entry.placeholders.map((placeholder) => placeholder.name);
}

export function findCommandGroupEntry(
  entries: readonly CommandGroupEntry[],
  name: string,
): CommandGroupEntry | undefined {
  return entries.find((entry) => getCommandGroupNames(entry).includes(name));
}

export function removeCommandGroupNames(program: Command, entry: CommandGroupEntry) {
  for (const name of new Set(getCommandGroupNames(entry))) {
    removeCommandByName(program, name);
  }
}

export async function registerCommandGroupByName(
  program: Command,
  entries: readonly CommandGroupEntry[],
  name: string,
): Promise<boolean> {
  const entry = findCommandGroupEntry(entries, name);
  if (!entry) {
    return false;
  }
  removeCommandGroupNames(program, entry);
  await entry.register(program);
  return true;
}

export function registerLazyCommandGroup(
  program: Command,
  entry: CommandGroupEntry,
  placeholder: CommandGroupPlaceholder,
) {
  const command = program
    .command(placeholder.name, { hidden: placeholder.hidden })
    .description(placeholder.description);
  markCommanderLazyCommand(command);
  for (const option of placeholder.options ?? []) {
    command.option(option.flags, option.description);
  }
  command.allowUnknownOption(true).allowExcessArguments(true);
  command.action(async () => {
    removeCommandGroupNames(program, entry);
    await entry.register(program);
    // SAFETY: Commander 15 snapshots rawArgs on the root before invoking actions.
    const rootProgram = getRootCommand(command) as Command & { rawArgs: string[] };
    // Commander 15 snapshots the full parse input on the root before actions run.
    const parseArgv = buildParseArgv(rootProgram.rawArgs, rootProgram.name());
    const lazyCommandName = command.name();
    /** Restore parent-option placement without stealing options owned by the loaded child command. */
    function hoistLazyParentOptions(): string[] {
      let lazyCommandIndex = findCommandPathEnd(parseArgv, program);
      if (lazyCommandIndex === -1) {
        return parseArgv;
      }
      while (lazyCommandIndex < parseArgv.length) {
        const option = findOption(program, parseArgv[lazyCommandIndex] ?? "");
        if (!option) {
          break;
        }
        const count = optionTokenCount(option, parseArgv, lazyCommandIndex);
        if (count === 0) {
          return parseArgv;
        }
        lazyCommandIndex += count;
      }
      if (parseArgv[lazyCommandIndex] !== lazyCommandName) {
        return parseArgv;
      }

      const lazyCommand = program.commands.find((candidate) =>
        matchesCommandName(candidate, lazyCommandName),
      );
      if (!lazyCommand) {
        return parseArgv;
      }
      let selectedCommand = lazyCommand;
      const selectedCommands = [selectedCommand];

      const hoisted: string[] = [];
      const remaining: string[] = [];
      let acceptsSubcommands = true;
      for (let index = lazyCommandIndex + 1; index < parseArgv.length; index += 1) {
        const token = parseArgv[index] ?? "";
        if (token === "--") {
          remaining.push(...parseArgv.slice(index));
          break;
        }
        const childOption = findNearestOption(selectedCommands, token);
        const parentOption = findOption(program, token);
        const option = childOption ?? parentOption;
        if (option) {
          const count = optionTokenCount(option, parseArgv, index);
          if (count === 0) {
            return parseArgv;
          }
          const tokens = parseArgv.slice(index, index + count);
          (childOption ? remaining : hoisted).push(...tokens);
          index += count - 1;
          continue;
        }
        if (acceptsSubcommands && !token.startsWith("-")) {
          const nextCommand: Command | undefined = selectedCommand.commands.find((candidate) =>
            matchesCommandName(candidate, token),
          );
          if (nextCommand) {
            selectedCommand = nextCommand;
            selectedCommands.push(nextCommand);
          } else {
            acceptsSubcommands = false;
          }
        }
        remaining.push(token);
      }
      return hoisted.length === 0
        ? parseArgv
        : [...parseArgv.slice(0, lazyCommandIndex), ...hoisted, lazyCommandName, ...remaining];
    }
    const normalizedArgv = hoistLazyParentOptions();
    await rootProgram.parseAsync(normalizedArgv);
  });
}

export function registerCommandGroups(
  program: Command,
  entries: readonly CommandGroupEntry[],
  params: {
    eager: boolean;
    primary: string | null;
    registerPrimaryOnly: boolean;
  },
) {
  if (params.eager) {
    const resources = getCliPluginInvocationResources();
    for (const entry of entries) {
      if (resources) {
        resources.register(() => entry.register(program));
      } else {
        void entry.register(program);
      }
    }
    return;
  }

  if (params.primary && params.registerPrimaryOnly) {
    const entry = findCommandGroupEntry(entries, params.primary);
    if (entry) {
      const placeholder = entry.placeholders.find((candidate) => candidate.name === params.primary);
      if (placeholder) {
        registerLazyCommandGroup(program, entry, placeholder);
      }
      return;
    }
  }

  for (const entry of entries) {
    for (const placeholder of entry.placeholders) {
      registerLazyCommandGroup(program, entry, placeholder);
    }
  }
}
