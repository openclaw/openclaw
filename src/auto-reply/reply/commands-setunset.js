import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import { parseConfigValue } from "./config-value.js";
export function parseSetUnsetCommand(params) {
    const action = params.action;
    const args = params.args.trim();
    if (action === "unset") {
        if (!args) {
            return { kind: "error", message: `Usage: ${params.slash} unset path` };
        }
        return { kind: "unset", path: args };
    }
    if (!args) {
        return { kind: "error", message: `Usage: ${params.slash} set path=value` };
    }
    const eqIndex = args.indexOf("=");
    if (eqIndex <= 0) {
        return { kind: "error", message: `Usage: ${params.slash} set path=value` };
    }
    const path = args.slice(0, eqIndex).trim();
    const rawValue = args.slice(eqIndex + 1);
    if (!path) {
        return { kind: "error", message: `Usage: ${params.slash} set path=value` };
    }
    const parsed = parseConfigValue(rawValue);
    if (parsed.error) {
        return { kind: "error", message: parsed.error };
    }
    return { kind: "set", path, value: parsed.value };
}
export function parseSetUnsetCommandAction(params) {
    if (params.action !== "set" && params.action !== "unset") {
        return null;
    }
    const parsed = parseSetUnsetCommand({
        slash: params.slash,
        action: params.action,
        args: params.args,
    });
    if (parsed.kind === "error") {
        return params.onError(parsed.message);
    }
    return parsed.kind === "set"
        ? params.onSet(parsed.path, parsed.value)
        : params.onUnset(parsed.path);
}
export function parseSlashCommandWithSetUnset(params) {
    const parsed = parseSlashCommandOrNull(params.raw, params.slash, {
        invalidMessage: params.invalidMessage,
    });
    if (!parsed) {
        return null;
    }
    if (!parsed.ok) {
        return params.onError(parsed.message);
    }
    const { action, args } = parsed;
    const setUnset = parseSetUnsetCommandAction({
        slash: params.slash,
        action,
        args,
        onSet: params.onSet,
        onUnset: params.onUnset,
        onError: params.onError,
    });
    if (setUnset) {
        return setUnset;
    }
    const knownAction = params.onKnownAction(action, args);
    if (knownAction) {
        return knownAction;
    }
    return params.onError(params.usageMessage);
}
