import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildParseArgv } from "../argv.js";
import { resolveActionArgs, resolveCommandOptionArgs } from "./helpers.js";

const reparseLogger = createSubsystemLogger("cli/reparse");

function buildFallbackArgv(program: Command, actionCommand: Command | undefined): string[] {
  const actionArgsList = resolveActionArgs(actionCommand);
  const parentOptionArgs =
    actionCommand?.parent === program ? resolveCommandOptionArgs(program) : [];
  return actionCommand?.name()
    ? [...parentOptionArgs, actionCommand.name(), ...actionArgsList]
    : [...parentOptionArgs, ...actionArgsList];
}

/**
 * Reads Commander's `rawArgs` off a Command, guarding against the property
 * silently disappearing on a Commander upgrade.
 *
 * `rawArgs` is not part of Commander's public typings (it lives in the
 * internal implementation; package.json pins commander to 14.0.3). On a real
 * Command instance it is always an array — initialized to `[]` in the
 * constructor and set to `argv.slice()` after parse. So a real Command whose
 * `rawArgs` is `undefined` (or not an array) is a strong signal that Commander
 * removed, renamed, or reshaped the property. We surface that as a warning
 * instead of silently falling back to a reconstructed argv (which can omit
 * flags passed positionally).
 *
 * On a Commander bump, re-verify by searching commander's source for `rawArgs`
 * writes and running action-reparse.test.ts.
 */
function readCommanderRawArgs(root: Command): string[] | undefined {
  const rawArgs = (root as Command & { rawArgs?: unknown }).rawArgs;
  if (Array.isArray(rawArgs)) {
    return rawArgs as string[];
  }
  // Only a genuine Command instance is expected to expose `rawArgs`; mock
  // objects (e.g. in tests, or non-Command roots) legitimately lack it.
  if (root instanceof CommanderCommand) {
    reparseLogger.warn(
      "commander rawArgs missing or not an array on a Command instance; falling back to reconstructed argv",
      { typeofRawArgs: typeof rawArgs },
    );
  }
  return undefined;
}

export async function reparseProgramFromActionArgs(
  program: Command,
  actionArgs: unknown[],
): Promise<void> {
  const actionCommand = actionArgs.at(-1) as Command | undefined;
  const root = actionCommand?.parent ?? program;
  const rawArgs = readCommanderRawArgs(root);
  const fallbackArgv = buildFallbackArgv(program, actionCommand);
  const parseArgv = buildParseArgv({
    programName: program.name(),
    rawArgs,
    fallbackArgv,
  });
  await program.parseAsync(parseArgv);
}
