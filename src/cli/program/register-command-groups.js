import { removeCommandByName } from "./command-tree.js";
import { registerLazyCommand } from "./register-lazy-command.js";
export function getCommandGroupNames(entry) {
    return entry.names ?? entry.placeholders.map((placeholder) => placeholder.name);
}
export function findCommandGroupEntry(entries, name) {
    return entries.find((entry) => getCommandGroupNames(entry).includes(name));
}
export function removeCommandGroupNames(program, entry) {
    for (const name of new Set(getCommandGroupNames(entry))) {
        removeCommandByName(program, name);
    }
}
export async function registerCommandGroupByName(program, entries, name) {
    const entry = findCommandGroupEntry(entries, name);
    if (!entry) {
        return false;
    }
    removeCommandGroupNames(program, entry);
    await entry.register(program);
    return true;
}
export function registerLazyCommandGroup(program, entry, placeholder) {
    registerLazyCommand({
        program,
        name: placeholder.name,
        description: placeholder.description,
        removeNames: [...new Set(getCommandGroupNames(entry))],
        register: async () => {
            await entry.register(program);
        },
    });
}
export function registerCommandGroups(program, entries, params) {
    if (params.eager) {
        for (const entry of entries) {
            void entry.register(program);
        }
        return;
    }
    if (params.primary && params.registerPrimaryOnly) {
        const entry = findCommandGroupEntry(entries, params.primary);
        if (entry) {
            const placeholder = entry.placeholders.find((candidate) => candidate.name === params.primary);
            if (placeholder) {
                registerLazyCommandGroup(program, entry, placeholder);
            }
            return;
        }
    }
    for (const entry of entries) {
        for (const placeholder of entry.placeholders) {
            registerLazyCommandGroup(program, entry, placeholder);
        }
    }
}
