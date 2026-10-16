import type { Command, Option } from "commander";
import { consumeRootOptionToken } from "../infra/cli-root-options.js";

type ShellCompletionValueChoice = {
  flags: string[];
  choices: string[];
  requiresValue: boolean;
};

export type ShellCompletionContext = {
  command: Command;
  pathVariants: string[][];
  completions: string[];
  valueOptions: string[];
  requiredValueOptions: string[];
  valueChoices: ShellCompletionValueChoice[];
};

export type ShellCompletionCommandTree = ReturnType<typeof collectShellCompletionCommandTree>;

function completionFlags(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

export function completionOptions(command: Command): { option: Option; flags: string[] }[] {
  const options = command.options.map((option) => ({ option, flags: completionFlags(option) }));
  const shadowedFlags = new Set(options.flatMap(({ flags }) => flags));
  let root = command;
  while (root.parent) {
    if (root !== command) {
      for (const flag of root.options.flatMap(completionFlags)) {
        shadowedFlags.add(flag);
      }
    }
    root = root.parent;
  }
  if (root !== command) {
    // Only root-preprocessed flags work after positional subcommands. Keep local owners.
    for (const option of root.options) {
      const flags = completionFlags(option).filter(
        (flag) => !shadowedFlags.has(flag) && consumeRootOptionToken([flag], 0) > 0,
      );
      if (flags.length > 0) {
        options.push({ option, flags });
      }
    }
  }
  return options;
}

// Aliases are typeable command words; every completion surface must offer them
// alongside the canonical name or advertised commands appear nonexistent.
export function commandNameVariants(command: Command): string[] {
  return [command.name(), ...command.aliases()];
}

export function visibleCompletionCommands(command: Command): Command[] {
  // The help API also synthesizes a help command; completion dispatch uses registered nodes.
  return command
    .createHelp()
    .visibleCommands(command)
    .filter((child) => command.commands.includes(child));
}

export function collectShellCompletionCommandTree(program: Command) {
  const descendants: ShellCompletionContext[] = [];

  const visit = (
    command: Command,
    pathVariants: string[][],
    parent?: ShellCompletionContext,
  ): ShellCompletionContext => {
    const ownOptionFlags = new Set(command.options.flatMap(completionFlags));
    const context: ShellCompletionContext = {
      command,
      pathVariants,
      completions: [
        ...visibleCompletionCommands(command).flatMap(commandNameVariants),
        ...completionOptions(command)
          .filter(({ option }) => !option.hidden)
          .flatMap(({ flags }) => flags),
      ],
      valueOptions: [
        ...new Set([
          ...(parent?.valueOptions ?? []).filter((flag) => !ownOptionFlags.has(flag)),
          ...command.options.flatMap((option) =>
            option.required || option.optional ? completionFlags(option) : [],
          ),
        ]),
      ],
      requiredValueOptions: [
        ...(parent?.requiredValueOptions ?? []).filter((flag) => !ownOptionFlags.has(flag)),
        ...command.options.flatMap((option) => (option.required ? completionFlags(option) : [])),
      ],
      valueChoices: [
        ...(parent?.valueChoices ?? []).flatMap(({ flags, ...choice }) => {
          const inheritedFlags = flags.filter((flag) => !ownOptionFlags.has(flag));
          return inheritedFlags.length > 0 ? [{ flags: inheritedFlags, ...choice }] : [];
        }),
        ...command.options.flatMap((option) =>
          option.argChoices?.length
            ? [
                {
                  flags: completionFlags(option),
                  choices: [...option.argChoices],
                  requiresValue: option.required,
                },
              ]
            : [],
        ),
      ],
    };

    if (pathVariants[0]?.length) {
      descendants.push(context);
    }

    for (const child of command.commands) {
      visit(
        child,
        pathVariants.flatMap((parents) =>
          commandNameVariants(child).map((name) => parents.concat(name)),
        ),
        context,
      );
    }

    return context;
  };

  return { root: visit(program, [[]]), descendants };
}
