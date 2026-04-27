import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";
export function parseStandardSetUnsetSlashCommand(params) {
    return parseSlashCommandWithSetUnset({
        raw: params.raw,
        slash: params.slash,
        invalidMessage: params.invalidMessage,
        usageMessage: params.usageMessage,
        onKnownAction: params.onKnownAction,
        onSet: params.onSet ?? ((path, value) => ({ action: "set", path, value })),
        onUnset: params.onUnset ?? ((path) => ({ action: "unset", path })),
        onError: params.onError ?? ((message) => ({ action: "error", message })),
    });
}
