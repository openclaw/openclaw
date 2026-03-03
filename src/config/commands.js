import { normalizeChannelId } from "../channels/plugins/index.js";
import { isPlainObject } from "../infra/plain-object.js";
function resolveAutoDefault(providerId) {
    const id = normalizeChannelId(providerId);
    if (!id) {
        return false;
    }
    if (id === "discord" || id === "telegram") {
        return true;
    }
    if (id === "slack") {
        return false;
    }
    return false;
}
export function resolveNativeSkillsEnabled(params) {
    return resolveNativeCommandSetting(params);
}
export function resolveNativeCommandsEnabled(params) {
    return resolveNativeCommandSetting(params);
}
function resolveNativeCommandSetting(params) {
    const { providerId, providerSetting, globalSetting } = params;
    const setting = providerSetting === undefined ? globalSetting : providerSetting;
    if (setting === true) {
        return true;
    }
    if (setting === false) {
        return false;
    }
    return resolveAutoDefault(providerId);
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
function getOwnCommandFlagValue(config, key) {
    const { commands } = config ?? {};
    if (!isPlainObject(commands) || !Object.hasOwn(commands, key)) {
        return undefined;
    }
    return commands[key];
}
export function isCommandFlagEnabled(config, key) {
    return getOwnCommandFlagValue(config, key) === true;
}
export function isRestartEnabled(config) {
    return getOwnCommandFlagValue(config, "restart") !== false;
}
