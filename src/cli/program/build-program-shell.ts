import { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export function buildProgramShell(): { program: Command; ctx: ProgramContext } {
  const program = new Command();
  const ctx = createProgramContext();
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);
  return { program, ctx };
}
