import type { CommandsConfig } from "./types.js";
export type CommandFlagKey = {
    [K in keyof CommandsConfig]-?: Exclude<CommandsConfig[K], undefined> extends boolean ? K : never;
}[keyof CommandsConfig];
export declare function isCommandFlagEnabled(config: {
    commands?: unknown;
} | undefined, key: CommandFlagKey): boolean;
export declare function isRestartEnabled(config?: {
    commands?: unknown;
}): boolean;
