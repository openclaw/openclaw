import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
export function reserveSkillCommandNames(params) {
    for (const command of params.skillCommands) {
        params.reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
    }
}
export function resolveConfiguredDirectiveAliases(params) {
    if (!params.commandTextHasSlash) {
        return [];
    }
    return Object.values(params.cfg.agents?.defaults?.models ?? {})
        .map((entry) => normalizeOptionalString(entry.alias))
        .filter((alias) => Boolean(alias))
        .filter((alias) => !params.reservedCommands.has(normalizeLowercaseStringOrEmpty(alias)));
}
