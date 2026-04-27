import { sanitizeForLog } from "../../terminal/ansi.js";
const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export function normalizeCommandDescriptorName(name) {
    const normalized = name.trim();
    return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}
export function assertSafeCommandDescriptorName(name) {
    const normalized = normalizeCommandDescriptorName(name);
    if (!normalized) {
        throw new Error(`Invalid CLI command name: ${JSON.stringify(name.trim())}`);
    }
    return normalized;
}
export function sanitizeCommandDescriptorDescription(description) {
    return sanitizeForLog(description).trim();
}
export function getCommandDescriptorNames(descriptors) {
    return descriptors.map((descriptor) => descriptor.name);
}
export function getCommandsWithSubcommands(descriptors) {
    return descriptors
        .filter((descriptor) => descriptor.hasSubcommands)
        .map((descriptor) => descriptor.name);
}
export function collectUniqueCommandDescriptors(descriptorGroups) {
    const seen = new Set();
    const descriptors = [];
    for (const group of descriptorGroups) {
        for (const descriptor of group) {
            if (seen.has(descriptor.name)) {
                continue;
            }
            seen.add(descriptor.name);
            descriptors.push(descriptor);
        }
    }
    return descriptors;
}
export function defineCommandDescriptorCatalog(descriptors) {
    return {
        descriptors,
        getDescriptors: () => descriptors,
        getNames: () => getCommandDescriptorNames(descriptors),
        getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors),
    };
}
export function addCommandDescriptorsToProgram(program, descriptors, existingCommands = new Set()) {
    for (const descriptor of descriptors) {
        const name = assertSafeCommandDescriptorName(descriptor.name);
        if (existingCommands.has(name)) {
            continue;
        }
        program.command(name).description(sanitizeCommandDescriptorDescription(descriptor.description));
        existingCommands.add(name);
    }
    return existingCommands;
}
