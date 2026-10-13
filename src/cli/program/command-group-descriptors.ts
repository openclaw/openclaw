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

export type CommandGroupDescriptorSpec<TArgs extends unknown[] = []> = readonly [
  commandNames: readonly string[],
  register: (program: Command, ...args: TArgs) => Promise<void> | void,
];

/** Bind descriptors and registration arguments without importing the command modules. */
export function buildCommandGroupEntries<TArgs extends unknown[]>(
  descriptors: readonly NamedCommandDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TArgs>[],
  ...args: TArgs
) {
  const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return specs.flatMap(([commandNames, register]) => {
    const placeholders: NamedCommandDescriptor[] = [];
    for (const name of commandNames) {
      const descriptor = descriptorsByName.get(name);
      if (!descriptor) {
        return [];
      }
      placeholders.push(descriptor);
    }
    return [
      {
        names: commandNames,
        placeholders,
        register: (program: Command) => register(program, ...args),
      },
    ];
  });
}
