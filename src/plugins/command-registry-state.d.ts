import type { OpenClawPluginCommandDefinition } from "./types.js";
export type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
    pluginId: string;
    pluginName?: string;
    pluginRoot?: string;
};
export declare const pluginCommands: Map<string, RegisteredPluginCommand>;
export declare function isPluginCommandRegistryLocked(): boolean;
export declare function setPluginCommandRegistryLocked(locked: boolean): void;
export declare function clearPluginCommands(): void;
export declare function clearPluginCommandsForPlugin(pluginId: string): void;
export declare function listRegisteredPluginCommands(): RegisteredPluginCommand[];
export declare function restorePluginCommands(commands: readonly RegisteredPluginCommand[]): void;
export declare function getPluginCommandSpecs(provider?: string): Array<{
    name: string;
    description: string;
    acceptsArgs: boolean;
}>;
/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export declare function listProviderPluginCommandSpecs(provider?: string): Array<{
    name: string;
    description: string;
    acceptsArgs: boolean;
}>;
