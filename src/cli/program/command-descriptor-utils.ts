import type { Command } from "commander";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

/** Minimal command descriptor shape shared by core and sub-CLI placeholder catalogs. */
export type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description">;

const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type CommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor> = {
  /** Stable descriptor list used for help placeholders and command discovery. */
  descriptors: readonly TDescriptor[];
  /** Return descriptors without exposing a mutable backing array. */
  getDescriptors: () => readonly TDescriptor[];
  /** Return canonical command names for routing and tests. */
  getNames: () => string[];
  /** Commands whose placeholder should keep child help behavior. */
  getCommandsWithSubcommands: () => string[];
  /** Parent commands whose default action renders help instead of dispatching. */
  getParentDefaultHelpCommands: () => string[];
};

/** Accept only Commander-safe command names before registering placeholder commands. */
export function normalizeCommandDescriptorName(name: string): string | null {
  const normalized = name.trim();
  return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

function assertSafeCommandDescriptorName(name: string): string {
  const normalized = normalizeCommandDescriptorName(name);
  if (!normalized) {
    throw new Error(`Invalid CLI command name: ${JSON.stringify(name.trim())}`);
  }
  return normalized;
}

export function sanitizeCommandDescriptorDescription(description: string): string {
  return sanitizeForLog(description).trim();
}

/** Preserve descriptor order while projecting names for parser/routing tables. */
export function getCommandDescriptorNames(descriptors: readonly CommandDescriptorLike[]): string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

/** Return command names whose placeholders must behave as parent commands. */
export function getCommandsWithSubcommands(
  descriptors: readonly NamedCommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.hasSubcommands)
    .map((descriptor) => descriptor.name);
}

/** Return command names that should render parent help by default. */
export function getParentDefaultHelpCommands(
  descriptors: readonly NamedCommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.parentDefaultHelp)
    .map((descriptor) => descriptor.name);
}

/** Merge descriptor groups while keeping the first declaration for duplicate command names. */
export function collectUniqueCommandDescriptors<TDescriptor extends CommandDescriptorLike>(
  descriptorGroups: readonly (readonly TDescriptor[])[],
): TDescriptor[] {
  const seen = new Set<string>();
  const descriptors: TDescriptor[] = [];
  for (const group of descriptorGroups) {
    for (const descriptor of group) {
      if (seen.has(descriptor.name)) {
        continue;
      }
      seen.add(descriptor.name);
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/** Build a small catalog facade around an immutable descriptor list. */
export function defineCommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor>(
  descriptors: readonly TDescriptor[],
): CommandDescriptorCatalog<TDescriptor> {
  return {
    descriptors,
    getDescriptors: () => descriptors,
    getNames: () => getCommandDescriptorNames(descriptors),
    getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors),
    getParentDefaultHelpCommands: () => getParentDefaultHelpCommands(descriptors),
  };
}

/** Register sanitized placeholder commands, skipping names already installed on the program. */
export function addCommandDescriptorsToProgram(
  program: Command,
  descriptors: readonly CommandDescriptorLike[],
  existingCommands: Set<string> = new Set(),
): Set<string> {
  for (const descriptor of descriptors) {
    const name = assertSafeCommandDescriptorName(descriptor.name);
    if (existingCommands.has(name)) {
      continue;
    }
    program.command(name).description(sanitizeCommandDescriptorDescription(descriptor.description));
    existingCommands.add(name);
  }
  return existingCommands;
}
