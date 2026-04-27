import { getChannelPlugin } from "../channels/plugins/index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
const PLUGIN_COMMAND_STATE_KEY = Symbol.for("openclaw.pluginCommandsState");
const getState = () => resolveGlobalSingleton(PLUGIN_COMMAND_STATE_KEY, () => ({
    pluginCommands: new Map(),
    registryLocked: false,
}));
const getPluginCommandMap = () => getState().pluginCommands;
export const pluginCommands = new Proxy(new Map(), {
    get(_target, property) {
        const value = Reflect.get(getPluginCommandMap(), property, getPluginCommandMap());
        return typeof value === "function" ? value.bind(getPluginCommandMap()) : value;
    },
});
export function isPluginCommandRegistryLocked() {
    return getState().registryLocked;
}
export function setPluginCommandRegistryLocked(locked) {
    getState().registryLocked = locked;
}
export function clearPluginCommands() {
    pluginCommands.clear();
}
export function clearPluginCommandsForPlugin(pluginId) {
    for (const [key, cmd] of pluginCommands.entries()) {
        if (cmd.pluginId === pluginId) {
            pluginCommands.delete(key);
        }
    }
}
export function listRegisteredPluginCommands() {
    return Array.from(pluginCommands.values());
}
export function restorePluginCommands(commands) {
    pluginCommands.clear();
    for (const command of commands) {
        const name = normalizeOptionalLowercaseString(command.name);
        if (!name) {
            continue;
        }
        pluginCommands.set(`/${name}`, command);
    }
}
function resolvePluginNativeName(command, provider) {
    const providerName = normalizeOptionalLowercaseString(provider);
    const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
    if (typeof providerOverride === "string" && providerOverride.trim()) {
        return providerOverride.trim();
    }
    const defaultOverride = command.nativeNames?.default;
    if (typeof defaultOverride === "string" && defaultOverride.trim()) {
        return defaultOverride.trim();
    }
    return command.name;
}
export function getPluginCommandSpecs(provider) {
    const providerName = normalizeOptionalLowercaseString(provider);
    if (providerName &&
        getChannelPlugin(providerName)?.commands?.nativeCommandsAutoEnabled !== true) {
        return [];
    }
    return listProviderPluginCommandSpecs(provider);
}
/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider) {
    return Array.from(pluginCommands.values()).map((cmd) => ({
        name: resolvePluginNativeName(cmd, provider),
        description: cmd.description,
        acceptsArgs: cmd.acceptsArgs ?? false,
    }));
}
