import process from "node:process";
import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext, setProgramRawArgv } from "./program-context.js";

function installRawArgvTracking(program: Command): void {
  const originalParse = program.parse.bind(program);
  const originalParseAsync = program.parseAsync.bind(program);

  program.parse = ((argv, parseOptions) => {
    if (Array.isArray(argv)) {
      setProgramRawArgv(program, argv);
    }
    return originalParse(argv, parseOptions);
  }) as typeof program.parse;

  program.parseAsync = (async (argv, parseOptions) => {
    if (Array.isArray(argv)) {
      setProgramRawArgv(program, argv);
    }
    return await originalParseAsync(argv, parseOptions);
  }) as typeof program.parseAsync;
}

export function buildProgram(argv: readonly string[] = process.argv) {
  const program = new Command();
  const registrationArgv = [...argv];
  program.enablePositionalOptions();
  // Preserve Commander-computed exit codes while still aborting parse flow.
  // Without this, unknown nested commands can print an error
  // but still report success when exits are intercepted.
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const ctx = createProgramContext();

  setProgramContext(program, ctx);
  setProgramRawArgv(program, argv);
  installRawArgvTracking(program);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, registrationArgv);

  return program;
}
