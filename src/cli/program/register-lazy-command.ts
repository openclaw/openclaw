import type { Command } from "commander";
import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";

type RegisterLazyCommandParams = {
  program: Command;
  name: string;
  description: string;
  removeNames?: string[];
  register: () => Promise<void> | void;
};

export function registerLazyCommand({
  program,
  name,
  description,
  removeNames,
  register,
}: RegisterLazyCommandParams): void {
  const placeholder = program.command(name).description(description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  // Disable the placeholder's built-in help option so that flags like --help
  // are treated as unknown arguments and passed through to the action. Without
  // this, Commander intercepts --help at the placeholder level and prints the
  // placeholder's (empty) help text instead of forwarding the flag to the real
  // subcommand after lazy registration. The parent program's help option
  // remains active for top-level `openclaw --help` invocations.
  placeholder.helpOption(false);
  placeholder.action(async (...actionArgs) => {
    for (const commandName of new Set(removeNames ?? [name])) {
      removeCommandByName(program, commandName);
    }
    await register();
    await reparseProgramFromActionArgs(program, actionArgs);
  });
}
