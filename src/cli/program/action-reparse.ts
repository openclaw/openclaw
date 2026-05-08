import type { Command } from "commander";
import { buildParseArgv } from "../argv.js";
import { resolveActionArgs } from "./helpers.js";

export async function reparseProgramFromActionArgs(
  program: Command,
  actionArgs: unknown[],
): Promise<void> {
  const actionCommand = actionArgs.at(-1) as Command | undefined;
  const root = actionCommand?.parent ?? program;
  const rawArgs = (root as Command & { rawArgs?: string[] }).rawArgs;
  const actionArgsList = resolveActionArgs(actionCommand);
  const fallbackArgv = actionCommand?.name()
    ? [actionCommand.name(), ...actionArgsList]
    : actionArgsList;
  const parseArgv = buildParseArgv({
    programName: program.name(),
    rawArgs,
    fallbackArgv,
  });
  await program.parseAsync(parseArgv);
}
