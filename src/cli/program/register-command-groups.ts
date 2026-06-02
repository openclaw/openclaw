import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Command } from "commander";
import { removeCommandByName } from "./command-tree.js";
import { registerLazyCommand } from "./register-lazy-command.js";

export type CommandGroupPlaceholder = {
  /** Placeholder command name installed before the group module is loaded. */
  name: string;
  /** Help text shown while the real command group is still lazy. */
  description: string;
  /** Options that must be visible on the placeholder for parse/help parity. */
  options?: readonly CommandGroupPlaceholderOption[];
};

export type CommandGroupPlaceholderOption = {
  /** Commander option flags, e.g. `--json` or `-f, --force`. */
  flags: string;
  /** Placeholder help text for the option. */
  description: string;
};

export type CommandGroupEntry = {
  /** One or more placeholders that load the same command group. */
  placeholders: readonly CommandGroupPlaceholder[];
  /** Optional aliases/names removed before installing the real command group. */
  names?: readonly string[];
  /** Registers the real commands once the group is selected. */
  register: (program: Command) => Promise<void> | void;
};

/** Resolve every command name that belongs to a lazy command group. */
export function getCommandGroupNames(entry: CommandGroupEntry): readonly string[] {
  return entry.names ?? entry.placeholders.map((placeholder) => placeholder.name);
}

/** Find the group whose placeholder or alias owns a command name. */
export function findCommandGroupEntry(
  entries: readonly CommandGroupEntry[],
  name: string,
): CommandGroupEntry | undefined {
  return entries.find((entry) => getCommandGroupNames(entry).includes(name));
}

/** Remove all placeholder/alias commands before installing the real group. */
export function removeCommandGroupNames(program: Command, entry: CommandGroupEntry) {
  for (const name of new Set(getCommandGroupNames(entry))) {
    removeCommandByName(program, name);
  }
}

/** Eagerly register one command group by placeholder/alias name. */
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

/** Install one lazy placeholder that swaps itself for the real command group. */
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
    removeNames: uniqueStrings(getCommandGroupNames(entry)),
    register: async () => {
      await entry.register(program);
    },
  });
}

/** Register command groups eagerly, primary-only, or as full lazy placeholders. */
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
