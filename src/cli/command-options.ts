import type { Command } from "commander";

/** Return whether Commander saw any of the named options explicitly on the CLI. */
export function hasExplicitOptions(command: Command, names: readonly string[]): boolean {
  if (typeof command.getOptionValueSource !== "function") {
    return false;
  }
  return names.some((name) => command.getOptionValueSource(name) === "cli");
}

function getOptionSource(command: Command, name: string): string | undefined {
  if (typeof command.getOptionValueSource !== "function") {
    return undefined;
  }
  return command.getOptionValueSource(name);
}

// Defensive guardrail: allow expected parent/grandparent inheritance without unbounded deep traversal.
const MAX_INHERIT_DEPTH = 2;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Commander option values are typed by the caller.
/** Inherit an option value from a parent/grandparent command when the child kept its default. */
export function inheritOptionFromParent<T = unknown>(
  command: Command | undefined,
  name: string,
): T | undefined {
  if (!command) {
    return undefined;
  }

  const childSource = getOptionSource(command, name);
  if (childSource && childSource !== "default") {
    return undefined;
  }

  let depth = 0;
  let ancestor = command.parent;
  while (ancestor && depth < MAX_INHERIT_DEPTH) {
    const source = getOptionSource(ancestor, name);
    if (source && source !== "default") {
      return ancestor.opts<Record<string, unknown>>()[name] as T | undefined;
    }
    depth += 1;
    ancestor = ancestor.parent;
  }
  return undefined;
}
