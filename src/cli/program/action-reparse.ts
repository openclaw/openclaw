// Reparse support for lazy commands after their placeholder has been replaced.
import type { Command } from "commander";
import { buildParseArgv } from "../argv.js";
import {
  hoistParentOptionsBeforeSubcommand,
  resolveActionArgs,
  resolveCommandOptionArgs,
} from "./helpers.js";

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
  // For nested lazy commands (e.g. workspaces → audit), `program` is a sub-command
  // whose rawArgs is cleared by Commander's restoreStateBeforeParse(). Only the
  // root program retains the rawArgs set by _prepareUserArgs.
  const rootProgram = findRootCommand(actionCommand ?? program);
  const rawArgs = (rootProgram as Command & { rawArgs?: string[] }).rawArgs;
  const fallbackArgv = buildFallbackArgv(program, actionCommand);
  const parseArgv = buildParseArgv({
    programName: rootProgram.name(),
    rawArgs,
    fallbackArgv,
  });
  // A parent option placed after a lazy subcommand (`browser tabs --browser-profile
  // remote`) is rejected by the real subcommand on reparse, because Commander binds
  // options to the command they follow. The lazy placeholder accepted it as an
  // unknown option, so hoist such parent/ancestor options back before the subcommand
  // before re-parsing. This is a no-op when parent options already precede the
  // subcommand.
  const normalizedArgv = actionCommand
    ? hoistParentOptionsBeforeSubcommand({
        argv: parseArgv,
        parentCommand: program,
        subcommandName: actionCommand.name(),
        subcommandCommand: program.commands.find(
          (command) => command.name() === actionCommand.name(),
        ),
      })
    : parseArgv;
  await rootProgram.parseAsync(normalizedArgv);
}
