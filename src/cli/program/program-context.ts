import type { Command } from "commander";
import type { ProgramContext } from "./context.js";

const PROGRAM_CONTEXT_SYMBOL: unique symbol = Symbol.for("openclaw.cli.programContext");

/** Attach shared CLI startup context to the root Commander program. */
export function setProgramContext(program: Command, ctx: ProgramContext): void {
  (program as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[PROGRAM_CONTEXT_SYMBOL] =
    ctx;
}

/** Read the shared CLI startup context from a Commander program. */
export function getProgramContext(program: Command): ProgramContext | undefined {
  return (program as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[
    PROGRAM_CONTEXT_SYMBOL
  ];
}
