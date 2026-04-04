import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext } from "./program-context.js";

export function buildProgram() {
  const program = new Command();
  program.enablePositionalOptions();
  // Ensure Commander.js sets exit code on argument errors (fixes #60905)
  // Without this, commands like `openclaw sessions list` would print an error
  // but exit with code 0, breaking scripts and monitoring tools.
  program.exitOverride((err) => {
    if (err.code === "commander.help" || err.code === "commander.version") {
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  });
  const ctx = createProgramContext();
  const argv = process.argv;

  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, argv);

  return program;
}
