import type { Command } from "commander";
import { getCliPluginInvocationResources } from "../runtime-cleanup-scope.js";
import { reparseProgramFromActionCommand } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";
import { markCommanderLazyCommand } from "./commander-parse-facts.js";

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
    await reparseProgramFromActionCommand(program, command);
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
