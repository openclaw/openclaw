import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Command } from "commander";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

/** Minimal descriptor shape used before a command is fully registered. */
type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description" | "hidden">;

type PluginCliRegistrationDescriptor = Pick<
  NamedCommandDescriptor,
  "name" | "description" | "hasSubcommands" | "machineOutput"
>;

const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Normalize and validate a command descriptor name for safe Commander registration. */
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

/** Strip unsafe terminal content from descriptor descriptions. */
export function sanitizeCommandDescriptorDescription(description: string): string {
  return sanitizeForLog(description).trim();
}

/** Normalize CLI registration metadata before native registration or fixture capture. */
export function normalizePluginCliRegistrationMetadata(
  opts:
    | {
        parentPath?: readonly string[];
        commands?: readonly string[];
        descriptors?: readonly PluginCliRegistrationDescriptor[];
      }
    | undefined,
  reportError: (message: string) => void,
):
  | {
      parentPath: string[];
      commands: string[];
      descriptors: PluginCliRegistrationDescriptor[];
    }
  | undefined {
  const normalizeCommandRoot = (raw: string, source: "command" | "descriptor") => {
    const normalized = normalizeCommandDescriptorName(raw);
    if (!normalized) {
      reportError(`invalid cli ${source} name: ${JSON.stringify(raw.trim())}`);
    }
    return normalized;
  };
  const parentPath = (opts?.parentPath ?? []).map((segment) =>
    normalizeCommandRoot(segment, "command"),
  );
  if (!parentPath.every((segment) => segment !== null)) {
    return undefined;
  }
  const rootRegistration = parentPath.length === 0;
  const inputDescriptors = opts?.descriptors ?? [];
  const descriptors = inputDescriptors
    .map((descriptor) => {
      const name = normalizeCommandRoot(descriptor.name, "descriptor");
      const description = sanitizeCommandDescriptorDescription(descriptor.description);
      const machineOutput = rootRegistration ? descriptor.machineOutput : undefined;
      if (!name || !description) {
        return null;
      }
      const normalized: PluginCliRegistrationDescriptor = {
        name,
        description,
        hasSubcommands: descriptor.hasSubcommands,
      };
      if (machineOutput) {
        normalized.machineOutput = machineOutput;
      }
      return normalized;
    })
    .filter((descriptor): descriptor is PluginCliRegistrationDescriptor => descriptor !== null);
  const commands = uniqueStrings(
    [...(opts?.commands ?? []), ...descriptors.map((descriptor) => descriptor.name)]
      .map((command) => normalizeCommandRoot(command, "command"))
      .filter((command): command is string => command !== null),
  );
  if (commands.length === 0) {
    reportError("cli registration missing explicit commands metadata");
    return undefined;
  }
  return { parentPath, commands, descriptors };
}

/** Merge descriptor groups while keeping the first descriptor for each command name. */
export function collectUniqueCommandDescriptors<TDescriptor extends CommandDescriptorLike>(
  descriptorGroups: readonly (readonly TDescriptor[])[],
): TDescriptor[] {
  return dedupeByKey(descriptorGroups.flat(), (descriptor) => descriptor.name);
}

/** Add safe placeholder commands to Commander without duplicating existing command names. */
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
    program
      .command(name, { hidden: descriptor.hidden })
      .description(sanitizeCommandDescriptorDescription(descriptor.description));
    existingCommands.add(name);
  }
  return existingCommands;
}
