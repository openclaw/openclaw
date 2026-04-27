import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listRouteBindings } from "../config/bindings.js";
import { normalizeRouteBindingChannelId, resolveNormalizedRouteBindingMatch, } from "./binding-scope.js";
import { normalizeAgentId } from "./session-key.js";
export function listBindings(cfg) {
    return listRouteBindings(cfg);
}
export function listBoundAccountIds(cfg, channelId) {
    const normalizedChannel = normalizeRouteBindingChannelId(channelId);
    if (!normalizedChannel) {
        return [];
    }
    const ids = new Set();
    for (const binding of listBindings(cfg)) {
        const resolved = resolveNormalizedRouteBindingMatch(binding);
        if (!resolved || resolved.channelId !== normalizedChannel) {
            continue;
        }
        ids.add(resolved.accountId);
    }
    return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
export function resolveDefaultAgentBoundAccountId(cfg, channelId) {
    const normalizedChannel = normalizeRouteBindingChannelId(channelId);
    if (!normalizedChannel) {
        return null;
    }
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    for (const binding of listBindings(cfg)) {
        const resolved = resolveNormalizedRouteBindingMatch(binding);
        if (!resolved ||
            resolved.channelId !== normalizedChannel ||
            resolved.agentId !== defaultAgentId) {
            continue;
        }
        return resolved.accountId;
    }
    return null;
}
export function buildChannelAccountBindings(cfg) {
    const map = new Map();
    for (const binding of listBindings(cfg)) {
        const resolved = resolveNormalizedRouteBindingMatch(binding);
        if (!resolved) {
            continue;
        }
        const byAgent = map.get(resolved.channelId) ?? new Map();
        const list = byAgent.get(resolved.agentId) ?? [];
        if (!list.includes(resolved.accountId)) {
            list.push(resolved.accountId);
        }
        byAgent.set(resolved.agentId, list);
        map.set(resolved.channelId, byAgent);
    }
    return map;
}
export function resolvePreferredAccountId(params) {
    if (params.boundAccounts.length > 0) {
        return params.boundAccounts[0];
    }
    return params.defaultAccountId;
}
