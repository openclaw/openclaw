import type { Command } from "commander";

export type NamedCommandDescriptor = {
  /** Commander-safe command name used for placeholders and routing. */
  name: string;
  /** Help text for the placeholder before lazy registration loads the real command. */
  description: string;
  /** Whether the placeholder should be treated as a parent command. */
  hasSubcommands: boolean;
  /** Whether invoking the parent without subcommands should render help. */
  parentDefaultHelp?: boolean;
};

export type CommandGroupDescriptorSpec<TRegister> = {
  /** Descriptor names that should resolve to the same lazy-loaded command group. */
  commandNames: readonly string[];
  /** Registrar callback or callback factory used after descriptor lookup. */
  register: TRegister;
};

export type ImportedCommandGroupDefinition<TRegisterArgs, TModule> = {
  /** Descriptor names owned by the imported module. */
  commandNames: readonly string[];
  /** Lazy module loader kept out of startup until the group is selected. */
  loadModule: () => Promise<TModule>;
  /** Module-specific registrar invoked after lazy import resolves. */
  register: (module: TModule, args: TRegisterArgs) => Promise<void> | void;
};

export type ResolvedCommandGroupEntry<TDescriptor extends NamedCommandDescriptor, TRegister> = {
  /** Descriptor objects resolved from `commandNames`; throws if any name is unknown. */
  placeholders: TDescriptor[];
  /** Registrar carried through from the owning spec. */
  register: TRegister;
};

type CommandGroupEntryLike = {
  placeholders: NamedCommandDescriptor[];
  register: (program: Command) => Promise<void> | void;
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

/** Resolve descriptor specs and adapt each registrar to the concrete command-group entry shape. */
export function buildCommandGroupEntries<TRegister>(
  descriptors: readonly NamedCommandDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TRegister>[],
  mapRegister: (register: TRegister) => CommandGroupEntryLike["register"],
): CommandGroupEntryLike[] {
  return resolveCommandGroupEntries(descriptors, specs).map((entry) => ({
    placeholders: entry.placeholders,
    register: mapRegister(entry.register),
  }));
}

/** Define a lazy imported group while preserving the typed registrar arguments. */
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

/** Map multiple imported group definitions into descriptor specs. */
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
type AnyImportedProgramCommandGroupDefinition = {
  commandNames: readonly string[];
  loadModule: () => Promise<Record<string, unknown>>;
  exportName: string;
};

export type ImportedProgramCommandGroupDefinition<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
> = {
  /** Descriptor names owned by the program command module. */
  commandNames: readonly string[];
  /** Lazy module loader for the command module. */
  loadModule: () => Promise<TModule>;
  /** Exported registrar name to call after import. */
  exportName: TKey;
};

/** Define a typed program command group that calls a named module export. */
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

/** Define program command groups from untyped module metadata with runtime export checks. */
export function defineImportedProgramCommandGroupSpecs(
  definitions: readonly AnyImportedProgramCommandGroupDefinition[],
): CommandGroupDescriptorSpec<(program: Command) => Promise<void>>[] {
  return definitions.map((definition) => ({
    commandNames: definition.commandNames,
    register: async (program: Command) => {
      const module = await definition.loadModule();
      const register = module[definition.exportName];
      if (typeof register !== "function") {
        throw new Error(`Missing program command registrar: ${definition.exportName}`);
      }
      await register(program);
    },
  }));
}
