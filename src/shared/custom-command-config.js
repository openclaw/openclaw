import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const DEFAULT_PREFIX = "/";
export function normalizeSlashCommandName(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    const withoutSlash = trimmed.startsWith(DEFAULT_PREFIX) ? trimmed.slice(1) : trimmed;
    return normalizeLowercaseStringOrEmpty(withoutSlash).replace(/-/g, "_");
}
export function normalizeCommandDescription(value) {
    return value.trim();
}
export function resolveCustomCommands(params) {
    const entries = Array.isArray(params.commands) ? params.commands : [];
    const reserved = params.reservedCommands ?? new Set();
    const checkReserved = params.checkReserved !== false;
    const checkDuplicates = params.checkDuplicates !== false;
    const seen = new Set();
    const resolved = [];
    const issues = [];
    const label = params.config.label;
    const prefix = params.config.prefix ?? DEFAULT_PREFIX;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const normalized = normalizeSlashCommandName(entry?.command ?? "");
        if (!normalized) {
            issues.push({
                index,
                field: "command",
                message: `${label} custom command is missing a command name.`,
            });
            continue;
        }
        if (!params.config.pattern.test(normalized)) {
            issues.push({
                index,
                field: "command",
                message: `${label} custom command "${prefix}${normalized}" is invalid (${params.config.patternDescription}).`,
            });
            continue;
        }
        if (checkReserved && reserved.has(normalized)) {
            issues.push({
                index,
                field: "command",
                message: `${label} custom command "${prefix}${normalized}" conflicts with a native command.`,
            });
            continue;
        }
        if (checkDuplicates && seen.has(normalized)) {
            issues.push({
                index,
                field: "command",
                message: `${label} custom command "${prefix}${normalized}" is duplicated.`,
            });
            continue;
        }
        const description = normalizeCommandDescription(entry?.description ?? "");
        if (!description) {
            issues.push({
                index,
                field: "description",
                message: `${label} custom command "${prefix}${normalized}" is missing a description.`,
            });
            continue;
        }
        if (checkDuplicates) {
            seen.add(normalized);
        }
        resolved.push({ command: normalized, description });
    }
    return { commands: resolved, issues };
}
