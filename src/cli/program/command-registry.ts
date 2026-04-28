import type { Command } from "commander";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNames,
  getCoreCliCommandsWithSubcommands,
  type CommandRegistration,
  registerCoreCliByName,
  registerCoreCliCommands,
} from "./command-registry-core.js";
import type { ProgramContext } from "./context.js";
import { registerSubCliCommands } from "./register.subclis.js";

export {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNames,
  getCoreCliCommandsWithSubcommands,
  registerCoreCliByName,
  registerCoreCliCommands,
};
export type { CommandRegistration };

export async function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
): Promise<void> {
  await registerCoreCliCommands(program, ctx, argv);
  await registerSubCliCommands(program, argv);
}
