import { Command } from "commander";
import type { ChannelOptionsProvider, ProgramContext } from "./context.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

export type ProgramShell = {
  program: Command;
  ctx: ProgramContext;
  provideChannelOptions: (fn: ChannelOptionsProvider) => void;
};

export function buildProgramShell(): ProgramShell {
  const program = new Command();
  let channelOptionsProvider: ChannelOptionsProvider | undefined;
  const ctx = createProgramContext(() => channelOptionsProvider?.() ?? []);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);
  return {
    program,
    ctx,
    provideChannelOptions(fn: ChannelOptionsProvider) {
      channelOptionsProvider = fn;
    },
  };
}
