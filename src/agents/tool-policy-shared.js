import { CORE_TOOL_GROUPS, resolveCoreToolProfilePolicy, } from "./tool-catalog.js";
const TOOL_NAME_ALIASES = {
    bash: "exec",
    "apply-patch": "apply_patch",
};
export const TOOL_GROUPS = { ...CORE_TOOL_GROUPS };
export function normalizeToolName(name) {
    const normalized = name.trim().toLowerCase();
    return TOOL_NAME_ALIASES[normalized] ?? normalized;
}
export function normalizeToolList(list) {
    if (!list) {
        return [];
    }
    return list.map(normalizeToolName).filter(Boolean);
}
export function expandToolGroups(list) {
    const normalized = normalizeToolList(list);
    const expanded = [];
    for (const value of normalized) {
        const group = TOOL_GROUPS[value];
        if (group) {
            expanded.push(...group);
            continue;
        }
        expanded.push(value);
    }
    return Array.from(new Set(expanded));
}
export function resolveToolProfilePolicy(profile) {
    return resolveCoreToolProfilePolicy(profile);
}
