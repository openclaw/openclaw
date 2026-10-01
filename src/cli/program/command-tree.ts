// Commander tree traversal and mutation shared by parsing and lazy command replacement.
import type { Command } from "commander";

export function getCommandHierarchy(command: Command): Command[] {
  const hierarchy: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    hierarchy.unshift(current);
  }
  return hierarchy;
}

export function getRootCommand(command: Command): Command {
  let root = command;
  while (root.parent) {
    root = root.parent;
  }
  return root;
}

/** Remove a command by primary name or alias. */
export function removeCommandByName(program: Command, name: string): boolean {
  const commands = program.commands as Command[];
  const index = commands.findIndex(
    (command) => command.name() === name || command.aliases().includes(name),
  );
  if (index < 0) {
    return false;
  }
  commands.splice(index, 1);
  return true;
}
