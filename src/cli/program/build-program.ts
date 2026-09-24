// Builds the root Commander program, context, help, hooks, and command registry.
import process from "node:process";
import { registerCoreCliCommands } from "./command-registry-core.js";
import { createProgramContext, type ProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext } from "./program-context.js";
import { registerSubCliCommands } from "./register.subclis.js";

export function buildProgram(
  prepared?: Pick<ProgramContext, "doctorDatabasePreflight" | "runtimeRecoveryEnv">,
) {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  // Preserve Commander-computed exit codes while still aborting parse flow.
  // Without this, unknown nested commands can print an error
  // but still report success when exits are intercepted.
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const ctx = createProgramContext(prepared);
  const argv = process.argv;

  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerCoreCliCommands(program, ctx, argv);
  registerSubCliCommands(program, argv);

  return program;
}
