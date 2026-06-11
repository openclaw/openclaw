// Lazy Commander placeholder registration used to keep CLI startup imports small.
import type { Command } from "commander";
import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";
import { resolveCommandOptionArgs } from "./helpers.js";

type RegisterLazyCommandParams = {
  program: Command;
  name: string;
  description: string;
  options?: readonly {
    flags: string;
    description: string;
  }[];
  removeNames?: string[];
  register: () => Promise<void> | void;
};

/** Register a placeholder that loads the real command and reparses the original invocation. */
export function registerLazyCommand({
  program,
  name,
  description,
  options,
  removeNames,
  register,
}: RegisterLazyCommandParams): void {
  const placeholder = program.command(name).description(description);
  for (const option of options ?? []) {
    placeholder.option(option.flags, option.description);
  }
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    const actionCommand = actionArgs.at(-1) as (Command & { args?: string[] }) | undefined;
    if (actionCommand) {
      // Commander separates option values from positional args on placeholders; restore them
      // before reparsing so the real command sees the original token order.
      actionCommand.args = [
        ...resolveCommandOptionArgs(actionCommand),
        ...(actionCommand.args ?? []),
      ];
    }
    for (const commandName of new Set(removeNames ?? [name])) {
      removeCommandByName(program, commandName);
    }
    await register();
    try {
      await reparseProgramFromActionArgs(program, actionArgs);
    } catch (err) {
      // Commander's exitOverride (in build-program.ts) sets process.exitCode and
      // throws. When the reparse error propagates through the lazy-command promise
      // chain, ensure the exit code survives so run-main.ts can also record it.
      if (
        err &&
        typeof err === "object" &&
        "exitCode" in err &&
        typeof (err as { exitCode: unknown }).exitCode === "number" &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string" &&
        (err as { code: string }).code.startsWith("commander.")
      ) {
        process.exitCode = (err as { exitCode: number }).exitCode;
      }
      throw err;
    }
  });
}
