import type { Command } from "commander";
import { removeCommandByName } from "./command-tree.js";
import { registerLazyCommand } from "./register-lazy-command.js";

export type CommandGroupPlaceholder = {
  name: string;
  description: string;
};

export type CommandGroupEntry = {
  placeholders: readonly CommandGroupPlaceholder[];
  register: (program: Command) => Promise<void> | void;
};

function findCommandGroupEntry(
  entries: readonly CommandGroupEntry[],
  name: string,
): CommandGroupEntry | undefined {
  return entries.find((entry) =>
    entry.placeholders.some((placeholder) => placeholder.name === name),
  );
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
  for (const placeholder of entry.placeholders) {
    removeCommandByName(program, placeholder.name);
  }
  await entry.register(program);
  return true;
}

function registerLazyCommandGroup(
  program: Command,
  entry: CommandGroupEntry,
  placeholder: CommandGroupPlaceholder,
) {
  registerLazyCommand({
    program,
    name: placeholder.name,
    description: placeholder.description,
    removeNames: entry.placeholders.map((candidate) => candidate.name),
    register: async () => {
      await entry.register(program);
    },
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
    for (const entry of entries) {
      void entry.register(program);
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
