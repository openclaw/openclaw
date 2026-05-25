import type { Command } from "commander";
import type { ProgramContext } from "./context.js";

const PROGRAM_CONTEXT_SYMBOL: unique symbol = Symbol.for("openclaw.cli.programContext");
const PROGRAM_RAW_ARGV_SYMBOL: unique symbol = Symbol.for("openclaw.cli.programRawArgv");

export function setProgramContext(program: Command, ctx: ProgramContext): void {
  (program as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[PROGRAM_CONTEXT_SYMBOL] =
    ctx;
}

export function getProgramContext(program: Command): ProgramContext | undefined {
  for (let current: Command | null | undefined = program; current; current = current.parent) {
    const ctx = (current as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[
      PROGRAM_CONTEXT_SYMBOL
    ];
    if (ctx) {
      return ctx;
    }
  }
  return undefined;
}

export function setProgramRawArgv(program: Command, rawArgv: readonly string[]): void {
  (program as Command & { [PROGRAM_RAW_ARGV_SYMBOL]?: string[] })[PROGRAM_RAW_ARGV_SYMBOL] = [
    ...rawArgv,
  ];
}

export function getProgramRawArgv(program: Command): string[] | undefined {
  for (let current: Command | null | undefined = program; current; current = current.parent) {
    const rawArgv = (current as Command & { [PROGRAM_RAW_ARGV_SYMBOL]?: string[] })[
      PROGRAM_RAW_ARGV_SYMBOL
    ];
    if (Array.isArray(rawArgv)) {
      return [...rawArgv];
    }
  }
  return undefined;
}
