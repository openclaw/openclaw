import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { getActivePluginChannelRegistryVersionFromState } from "../plugins/runtime-channel-state.js";
import { assertCommandRegistry, buildBuiltinChatCommands, defineChatCommand, } from "./commands-registry.shared.js";
function supportsNativeCommands(plugin) {
    return plugin.capabilities?.nativeCommands === true;
}
function defineDockCommand(plugin) {
    return defineChatCommand({
        key: `dock:${plugin.id}`,
        nativeName: `dock_${plugin.id}`,
        description: `Switch to ${plugin.id} for replies.`,
        textAliases: [`/dock-${plugin.id}`, `/dock_${plugin.id}`],
        category: "docks",
    });
}
let cachedCommands = null;
let cachedRegistryVersion = -1;
let cachedNativeCommandSurfaces = null;
let cachedNativeRegistryVersion = -1;
function buildChatCommands() {
    const commands = [
        ...buildBuiltinChatCommands(),
        ...listLoadedChannelPlugins()
            .filter(supportsNativeCommands)
            .map((plugin) => defineDockCommand(plugin)),
    ];
    assertCommandRegistry(commands);
    return commands;
}
export function getChatCommands() {
    const registryVersion = getActivePluginChannelRegistryVersionFromState();
    if (cachedCommands && registryVersion === cachedRegistryVersion) {
        return cachedCommands;
    }
    const commands = buildChatCommands();
    cachedCommands = commands;
    cachedRegistryVersion = registryVersion;
    cachedNativeCommandSurfaces = null;
    return commands;
}
export function getNativeCommandSurfaces() {
    const registryVersion = getActivePluginChannelRegistryVersionFromState();
    if (cachedNativeCommandSurfaces && registryVersion === cachedNativeRegistryVersion) {
        return cachedNativeCommandSurfaces;
    }
    cachedNativeCommandSurfaces = new Set(listLoadedChannelPlugins()
        .filter(supportsNativeCommands)
        .map((plugin) => plugin.id));
    cachedNativeRegistryVersion = registryVersion;
    return cachedNativeCommandSurfaces;
}
