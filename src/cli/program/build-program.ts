import { buildProgramShell } from "./build-program-shell.js";
import { registerProgramCommands } from "./command-registry.js";

export function buildProgram() {
  const { program, ctx } = buildProgramShell();
  registerProgramCommands(program, ctx, process.argv);
  return program;
}
