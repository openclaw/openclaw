import { expandToolGroups, normalizeToolList, normalizeToolName, } from "./tool-policy-shared.js";
export { expandToolGroups, normalizeToolList, normalizeToolName, resolveToolProfilePolicy, TOOL_GROUPS, } from "./tool-policy-shared.js";
// Keep tool-policy browser-safe: do not import tools/common at runtime.
function wrapOwnerOnlyToolExecution(tool, senderIsOwner) {
    if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
        return tool;
    }
    return {
        ...tool,
        execute: async () => {
            throw new Error("Tool restricted to owner senders.");
        },
    };
}
const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set(["whatsapp_login", "cron", "gateway"]);
export function isOwnerOnlyToolName(name) {
    return OWNER_ONLY_TOOL_NAME_FALLBACKS.has(normalizeToolName(name));
}
function isOwnerOnlyTool(tool) {
    return tool.ownerOnly === true || isOwnerOnlyToolName(tool.name);
}
export function applyOwnerOnlyToolPolicy(tools, senderIsOwner) {
    const withGuard = tools.map((tool) => {
        if (!isOwnerOnlyTool(tool)) {
            return tool;
        }
        return wrapOwnerOnlyToolExecution(tool, senderIsOwner);
    });
    if (senderIsOwner) {
        return withGuard;
    }
    return withGuard.filter((tool) => !isOwnerOnlyTool(tool));
}
export function collectExplicitAllowlist(policies) {
    const entries = [];
    for (const policy of policies) {
        if (!policy?.allow) {
            continue;
        }
        for (const value of policy.allow) {
            if (typeof value !== "string") {
                continue;
            }
            const trimmed = value.trim();
            if (trimmed) {
                entries.push(trimmed);
            }
        }
    }
    return entries;
}
export function buildPluginToolGroups(params) {
    const all = [];
    const byPlugin = new Map();
    for (const tool of params.tools) {
        const meta = params.toolMeta(tool);
        if (!meta) {
            continue;
        }
        const name = normalizeToolName(tool.name);
        all.push(name);
        const pluginId = meta.pluginId.toLowerCase();
        const list = byPlugin.get(pluginId) ?? [];
        list.push(name);
        byPlugin.set(pluginId, list);
    }
    return { all, byPlugin };
}
export function expandPluginGroups(list, groups) {
    if (!list || list.length === 0) {
        return list;
    }
    const expanded = [];
    for (const entry of list) {
        const normalized = normalizeToolName(entry);
        if (normalized === "group:plugins") {
            if (groups.all.length > 0) {
                expanded.push(...groups.all);
            }
            else {
                expanded.push(normalized);
            }
            continue;
        }
        const tools = groups.byPlugin.get(normalized);
        if (tools && tools.length > 0) {
            expanded.push(...tools);
            continue;
        }
        expanded.push(normalized);
    }
    return Array.from(new Set(expanded));
}
export function expandPolicyWithPluginGroups(policy, groups) {
    if (!policy) {
        return undefined;
    }
    return {
        allow: expandPluginGroups(policy.allow, groups),
        deny: expandPluginGroups(policy.deny, groups),
    };
}
export function stripPluginOnlyAllowlist(policy, groups, coreTools) {
    if (!policy?.allow || policy.allow.length === 0) {
        return { policy, unknownAllowlist: [], strippedAllowlist: false };
    }
    const normalized = normalizeToolList(policy.allow);
    if (normalized.length === 0) {
        return { policy, unknownAllowlist: [], strippedAllowlist: false };
    }
    const pluginIds = new Set(groups.byPlugin.keys());
    const pluginTools = new Set(groups.all);
    const unknownAllowlist = [];
    let hasCoreEntry = false;
    for (const entry of normalized) {
        if (entry === "*") {
            hasCoreEntry = true;
            continue;
        }
        const isPluginEntry = entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
        const expanded = expandToolGroups([entry]);
        const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
        if (isCoreEntry) {
            hasCoreEntry = true;
        }
        if (!isCoreEntry && !isPluginEntry) {
            unknownAllowlist.push(entry);
        }
    }
    const strippedAllowlist = !hasCoreEntry;
    // When an allowlist contains only plugin tools, we strip it to avoid accidentally
    // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
    if (strippedAllowlist) {
        // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
        // We keep this note here for future maintainers.
    }
    return {
        policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
        unknownAllowlist: Array.from(new Set(unknownAllowlist)),
        strippedAllowlist,
    };
}
export function mergeAlsoAllowPolicy(policy, alsoAllow) {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
        return policy;
    }
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
}
