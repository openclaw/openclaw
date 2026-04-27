function buildDescriptorIndex(descriptors) {
    return new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
}
export function resolveCommandGroupEntries(descriptors, specs) {
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
export function buildCommandGroupEntries(descriptors, specs, mapRegister) {
    return resolveCommandGroupEntries(descriptors, specs).map((entry) => ({
        placeholders: entry.placeholders,
        register: mapRegister(entry.register),
    }));
}
export function defineImportedCommandGroupSpec(commandNames, loadModule, register) {
    return {
        commandNames,
        register: async (args) => {
            const module = await loadModule();
            await register(module, args);
        },
    };
}
export function defineImportedCommandGroupSpecs(definitions) {
    return definitions.map((definition) => defineImportedCommandGroupSpec(definition.commandNames, definition.loadModule, definition.register));
}
export function defineImportedProgramCommandGroupSpec(definition) {
    return defineImportedCommandGroupSpec(definition.commandNames, definition.loadModule, (module, program) => module[definition.exportName](program));
}
export function defineImportedProgramCommandGroupSpecs(definitions) {
    return definitions.map((definition) => ({
        commandNames: definition.commandNames,
        register: async (program) => {
            const module = await definition.loadModule();
            const register = module[definition.exportName];
            if (typeof register !== "function") {
                throw new Error(`Missing program command registrar: ${definition.exportName}`);
            }
            await register(program);
        },
    }));
}
