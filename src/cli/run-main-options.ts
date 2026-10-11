import type { Command as CommanderCommand, Option as CommanderOption } from "commander";
import { FLAG_TERMINATOR, isValueToken } from "../infra/cli-root-options.js";
import { normalizeRootNoColorArgv } from "./argv.js";

function findCommandOption(command: CommanderCommand, token: string): CommanderOption | undefined {
  const equalsIndex = token.indexOf("=");
  const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  return command.options.find((option) => option.long === flag || option.short === flag);
}

export function findSubcommand(
  command: CommanderCommand,
  name: string,
): CommanderCommand | undefined {
  return command.commands.find(
    (subcommand) => subcommand.name() === name || subcommand.aliases().includes(name),
  );
}

function shouldOptionConsumeFollowingToken(
  option: CommanderOption | undefined,
  token: string,
  next: string | undefined,
): boolean {
  if (!option || token.includes("=")) {
    return false;
  }
  if (option.required) {
    return true;
  }
  return option.optional && isValueToken(next);
}

export function resolveRootOptionRole(
  program: CommanderCommand,
  remainingArgs: readonly string[],
  optionIndex: number,
): "root" | "command" | "value" {
  let command = program;
  let pendingValue = false;
  for (let index = 0; index < optionIndex; index += 1) {
    const arg = remainingArgs[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      return "root";
    }
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = findCommandOption(command, arg);
      if (!option && index === optionIndex - 1 && !arg.includes("=")) {
        // Unknown option surfaces may allow arbitrary flags; keep the value-safe behavior there.
        return "value";
      }
      pendingValue = shouldOptionConsumeFollowingToken(option, arg, remainingArgs[index + 1]);
      continue;
    }
    command = findSubcommand(command, arg) ?? command;
  }
  if (pendingValue) {
    return "value";
  }

  const arg = remainingArgs[optionIndex];
  return command !== program && arg !== undefined && findCommandOption(command, arg) !== undefined
    ? "command"
    : "root";
}

export function normalizeRootNoColorArgvForProgram(
  argv: string[],
  program: CommanderCommand,
): string[] {
  return normalizeRootNoColorArgv(argv, {
    shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
      resolveRootOptionRole(program, remainingArgs, noColorIndex) === "value",
  });
}
