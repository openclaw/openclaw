import type { Command } from "commander";
import type { CommandGroupEntry } from "./register-command-groups.js";

export type NamedCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export type CommandGroupDescriptorSpec<TRegister> = {
  commandNames: readonly string[];
  register: TRegister;
};

export type ImportedCommandGroupDefinition<TRegisterArgs, TModule> = {
  commandNames: readonly string[];
  loadModule: () => Promise<TModule>;
  register: (module: TModule, args: TRegisterArgs) => Promise<void> | void;
};

export type ResolvedCommandGroupEntry<TDescriptor extends NamedCommandDescriptor, TRegister> = {
  placeholders: TDescriptor[];
  register: TRegister;
};

function buildDescriptorIndex<TDescriptor extends NamedCommandDescriptor>(
  descriptors: readonly TDescriptor[],
): Map<string, TDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
}

export function resolveCommandGroupEntries<TDescriptor extends NamedCommandDescriptor, TRegister>(
  descriptors: readonly TDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TRegister>[],
): ResolvedCommandGroupEntry<TDescriptor, TRegister>[] {
  const descriptorsByName = buildDescriptorIndex(descriptors);
  return specs.map((spec) => ({
    placeholders: spec.commandNames.map((name) => {
      const descriptor = descriptorsByName.get(name);
      if (!descriptor) {
        throw new Error(`Unknown command descriptor: ${name}`);
      }
      return descriptor;
    }),
    register: spec.register,
  }));
}

export function buildCommandGroupEntries<TDescriptor extends NamedCommandDescriptor, TRegister>(
  descriptors: readonly TDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TRegister>[],
  mapRegister: (register: TRegister) => CommandGroupEntry["register"],
): CommandGroupEntry[] {
  return resolveCommandGroupEntries(descriptors, specs).map((entry) => ({
    placeholders: entry.placeholders,
    register: mapRegister(entry.register),
  }));
}

export function defineImportedCommandGroupSpec<TRegisterArgs, TModule>(
  commandNames: readonly string[],
  loadModule: () => Promise<TModule>,
  register: (module: TModule, args: TRegisterArgs) => Promise<void> | void,
): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>> {
  return {
    commandNames,
    register: async (args: TRegisterArgs) => {
      const module = await loadModule();
      await register(module, args);
    },
  };
}

export function defineImportedCommandGroupSpecs<TRegisterArgs, TModule>(
  definitions: readonly ImportedCommandGroupDefinition<TRegisterArgs, TModule>[],
): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>>[] {
  return definitions.map((definition) =>
    defineImportedCommandGroupSpec(
      definition.commandNames,
      definition.loadModule,
      definition.register,
    ),
  );
}

type ProgramCommandRegistrar = (program: Command) => Promise<void> | void;

export type ImportedProgramCommandGroupDefinition<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
> = {
  commandNames: readonly string[];
  loadModule: () => Promise<TModule>;
  exportName: TKey;
};

export function defineImportedProgramCommandGroupSpec<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
>(
  definition: ImportedProgramCommandGroupDefinition<TModule, TKey>,
): CommandGroupDescriptorSpec<(program: Command) => Promise<void>> {
  return defineImportedCommandGroupSpec(
    definition.commandNames,
    definition.loadModule,
    (module, program: Command) => module[definition.exportName](program),
  );
}

export function defineImportedProgramCommandGroupSpecs<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
>(
  definitions: readonly ImportedProgramCommandGroupDefinition<TModule, TKey>[],
): CommandGroupDescriptorSpec<(program: Command) => Promise<void>>[] {
  return definitions.map((definition) => defineImportedProgramCommandGroupSpec(definition));
}
