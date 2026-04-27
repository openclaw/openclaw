import { isPlainObject } from "../infra/plain-object.js";
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
