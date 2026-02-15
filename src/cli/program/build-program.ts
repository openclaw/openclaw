import { resolveCliChannelOptions } from "../channel-options.js";
import { buildProgramShell } from "./build-program-shell.js";
import { registerProgramCommands } from "./command-registry.js";

export async function buildProgram() {
  const { program, ctx, provideChannelOptions } = buildProgramShell();
  provideChannelOptions(resolveCliChannelOptions);
  await registerProgramCommands(program, ctx, process.argv);
  return program;
}
