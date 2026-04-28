import type { Command } from "commander";
import { buildParseArgv } from "../argv.js";
import { resolveActionArgs, resolveCommandOptionArgs } from "./helpers.js";

function buildFallbackArgv(root: Command, actionCommand: Command | undefined): string[] {
  const actionArgsList = resolveActionArgs(actionCommand);
  // Walk root → actionCommand. For each intermediate parent, emit the command
  // name plus any non-default option args so nested paths like `openclaw
  // browser --browser-profile nuan status` reconstruct correctly when
  // `root.rawArgs` is empty. The leaf actionCommand's own options are skipped
  // here because they are already included in `actionArgsList`.
  const chain: Command[] = [];
  let cursor: Command | undefined = actionCommand;
  while (cursor && cursor !== root) {
    chain.unshift(cursor);
    cursor = cursor.parent ?? undefined;
  }
  const intermediateParents = chain.slice(0, -1);
  const out: string[] = [...resolveCommandOptionArgs(root)];
  for (const parent of intermediateParents) {
    const name = parent.name();
    if (name) {
      out.push(name);
    }
    out.push(...resolveCommandOptionArgs(parent));
  }
  const actionName = actionCommand?.name();
  if (actionName) {
    out.push(actionName);
  }
  return [...out, ...actionArgsList];
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
  const fallbackArgv = buildFallbackArgv(root, actionCommand);
  const parseArgv = buildParseArgv({
    programName: root.name(),
    rawArgs,
    fallbackArgv,
  });
  await root.parseAsync(parseArgv);
}
