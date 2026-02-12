import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export function buildProgram() {
  const program = new Command();
  // Allow subcommands to define options with the same name as parent options
  // (e.g. gateway --force vs gateway install --force). Without this, Commander
  // consumes the option at the parent level even when it appears after the
  // subcommand name.
  program.enablePositionalOptions();
  const ctx = createProgramContext();
  const argv = process.argv;

  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, argv);

  return program;
}
