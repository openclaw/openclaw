// Reparse support for lazy commands after their placeholder has been replaced.
import type { Command } from "commander";
import { buildParseArgv } from "../argv.js";
import { resolveActionArgs, resolveCommandOptionArgs } from "./helpers.js";

function buildFallbackArgv(program: Command, actionCommand: Command | undefined): string[] {
  const actionArgsList = resolveActionArgs(actionCommand);
  const parentOptionArgs =
    actionCommand?.parent === program ? resolveCommandOptionArgs(program) : [];
  return actionCommand?.name()
    ? [...parentOptionArgs, actionCommand.name(), ...actionArgsList]
    : [...parentOptionArgs, ...actionArgsList];
}

function findRootCommand(cmd: Command): Command {
  let current: Command = cmd;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

/** Rebuild argv from Commander action args and re-run parsing after lazy registration. */
export async function reparseProgramFromActionArgs(
  program: Command,
  actionArgs: unknown[],
): Promise<void> {
  const actionCommand = actionArgs.at(-1) as Command | undefined;
  // Use the true root program for argv reconstruction and parsing.
  // For nested lazy commands, `program` can be a sub-command whose Commander-
  // internal rawArgs is cleared by restoreStateBeforeParse().
  // If Commander removes rawArgs, buildParseArgv falls back to reconstructed argv.
  const rootProgram = findRootCommand(actionCommand ?? program);
  const rawArgs = (rootProgram as Command & { rawArgs?: string[] }).rawArgs;
  const fallbackArgv = buildFallbackArgv(program, actionCommand);
  const parseArgv = buildParseArgv({
    programName: rootProgram.name(),
    rawArgs,
    fallbackArgv,
  });
  await rootProgram.parseAsync(parseArgv);
}
