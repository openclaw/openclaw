import { Command } from "commander";
import { createProgramContext } from "./context.js";
import { registerProgramCommands } from "./command-registry.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export function buildProgram() {
  const program = new Command();
  const ctx = createProgramContext();
  const argv = process.argv;

  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, argv);

  return program;
}
