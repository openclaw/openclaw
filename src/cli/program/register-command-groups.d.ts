import type { Command } from "commander";
export type CommandGroupPlaceholder = {
    name: string;
    description: string;
};
export type CommandGroupEntry = {
    placeholders: readonly CommandGroupPlaceholder[];
    names?: readonly string[];
    register: (program: Command) => Promise<void> | void;
};
export declare function getCommandGroupNames(entry: CommandGroupEntry): readonly string[];
export declare function findCommandGroupEntry(entries: readonly CommandGroupEntry[], name: string): CommandGroupEntry | undefined;
export declare function removeCommandGroupNames(program: Command, entry: CommandGroupEntry): void;
export declare function registerCommandGroupByName(program: Command, entries: readonly CommandGroupEntry[], name: string): Promise<boolean>;
export declare function registerLazyCommandGroup(program: Command, entry: CommandGroupEntry, placeholder: CommandGroupPlaceholder): void;
export declare function registerCommandGroups(program: Command, entries: readonly CommandGroupEntry[], params: {
    eager: boolean;
    primary: string | null;
    registerPrimaryOnly: boolean;
}): void;
