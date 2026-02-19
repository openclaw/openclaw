import type { Command } from "commander";

export function addJsonOption(
  command: Command,
  description = "Output JSON",
  defaultValue = false,
): Command {
  return command.option("--json", description, defaultValue);
}

export function addVerboseOption(
  command: Command,
  description = "Verbose logging",
  defaultValue = false,
): Command {
  return command.option("--verbose", description, defaultValue);
}

export function addDebugOption(
  command: Command,
  description = "Alias for --verbose",
  defaultValue = false,
): Command {
  return command.option("--debug", description, defaultValue);
}

export function addTimeoutOption(
  command: Command,
  params: { flag?: string; description: string; defaultValue?: string },
): Command {
  const flag = params.flag ?? "--timeout <ms>";
  if (params.defaultValue === undefined) {
    return command.option(flag, params.description);
  }
  return command.option(flag, params.description, params.defaultValue);
}
