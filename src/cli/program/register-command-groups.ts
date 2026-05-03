import type { Command } from "commander";
import { removeCommandByName } from "./command-tree.js";
import { registerLazyCommand } from "./register-lazy-command.js";

export type CommandGroupPlaceholder = {
  name: string;
  description: string;
  options?: readonly CommandGroupPlaceholderOption[];
};

export type CommandGroupPlaceholderOption = {
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
  registerLazyCommand({
    program,
    name: placeholder.name,
    description: placeholder.description,
    options: placeholder.options,
    removeNames: [...new Set(getCommandGroupNames(entry))],
    register: async () => {
      await entry.register(program);
    },
  });
}

export async function registerCommandGroups(
  program: Command,
  entries: readonly CommandGroupEntry[],
  params: {
    eager: boolean;
    primary: string | null;
    registerPrimaryOnly: boolean;
  },
): Promise<void> {
  if (params.eager) {
    // Wait for all eager registrations to finish before returning. Each
    // entry.register typically performs a dynamic import, so firing them
    // without awaiting would race against the caller's subsequent
    // program.parseAsync and leave commands unregistered when argv is parsed.
    // Wrap in async so synchronous register implementations still flow through
    // Promise.all without tripping the await-thenable lint rule.
    await Promise.all(entries.map(async (entry) => entry.register(program)));
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
