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

export async function reparseProgramFromActionArgs(
  program: Command,
  actionArgs: unknown[],
): Promise<void> {
  const actionCommand = actionArgs.at(-1) as Command | undefined;
  // Walk up to the root program. Sub-commands dispatched via _dispatchSubcommand
  // do not have rawArgs populated by commander, so reparsing on the immediate
  // parent strips parent options (e.g. `--browser-profile <name>`) from the
  // reconstructed argv. Reparse from the root so the original argv — and any
  // parent option values it carries — is preserved across the lazy load.
  let root: Command = actionCommand?.parent ?? program;
  while (root.parent) {
    root = root.parent;
  }
  const rawArgs = (root as Command & { rawArgs?: string[] }).rawArgs;
  const fallbackArgv = buildFallbackArgv(program, actionCommand);
  const parseArgv = buildParseArgv({
    programName: root.name(),
    rawArgs,
    fallbackArgv,
  });
  await root.parseAsync(parseArgv);
}
