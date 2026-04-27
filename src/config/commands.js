import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
export { isCommandFlagEnabled, isRestartEnabled } from "./commands.flags.js";
function resolveAutoDefault(providerId, kind) {
    const id = normalizeChannelId(providerId);
    if (!id) {
        return false;
    }
    const plugin = getChannelPlugin(id);
    if (!plugin) {
        return false;
    }
    if (kind === "native") {
        return plugin.commands?.nativeCommandsAutoEnabled === true;
    }
    return plugin.commands?.nativeSkillsAutoEnabled === true;
}
export function resolveNativeSkillsEnabled(params) {
    return resolveNativeCommandSetting({ ...params, kind: "nativeSkills" });
}
export function resolveNativeCommandsEnabled(params) {
    return resolveNativeCommandSetting({ ...params, kind: "native" });
}
function resolveNativeCommandSetting(params) {
    const { providerId, providerSetting, globalSetting, kind = "native" } = params;
    const setting = providerSetting === undefined ? globalSetting : providerSetting;
    if (setting === true) {
        return true;
    }
    if (setting === false) {
        return false;
    }
    return resolveAutoDefault(providerId, kind);
}
export function isNativeCommandsExplicitlyDisabled(params) {
    const { providerSetting, globalSetting } = params;
    if (providerSetting === false) {
        return true;
    }
    if (providerSetting === undefined) {
        return globalSetting === false;
    }
    return false;
}
