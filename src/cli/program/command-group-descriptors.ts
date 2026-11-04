import type { Command } from "commander";
import type { MachineOutputResolver } from "../machine-output-argv.js";

export type NamedCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
  machineOutput?: MachineOutputResolver;
  hidden?: boolean;
  parentDefaultHelp?: boolean;
};

export type RegisteredCommandDescriptor<TArgs extends unknown[] = []> = NamedCommandDescriptor & {
  register: (program: Command, ...args: TArgs) => Promise<void> | void;
};
