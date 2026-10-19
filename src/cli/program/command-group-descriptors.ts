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

/** Bind descriptors and registration arguments without importing the command modules. */
export function buildCommandGroupEntries<TArgs extends unknown[]>(
  descriptors: readonly RegisteredCommandDescriptor<TArgs>[],
  ...args: TArgs
) {
  const groups = new Map<
    RegisteredCommandDescriptor<TArgs>["register"],
    { placeholders: NamedCommandDescriptor[]; register: (program: Command) => Promise<void> | void }
  >();
  for (const descriptor of descriptors) {
    const group = groups.get(descriptor.register);
    if (group) {
      group.placeholders.push(descriptor);
    } else {
      groups.set(descriptor.register, {
        placeholders: [descriptor],
        register: (program: Command) => descriptor.register(program, ...args),
      });
    }
  }
  return [...groups.values()];
}
