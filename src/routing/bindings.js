import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";
function normalizeBindingChannelId(raw) {
    const normalized = normalizeChatChannelId(raw);
    if (normalized) {
        return normalized;
    }
    const fallback = (raw ?? "").trim().toLowerCase();
    return fallback || null;
}
export function listBindings(cfg) {
    return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
function resolveNormalizedBindingMatch(binding) {
    if (!binding || typeof binding !== "object") {
        return null;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
        return null;
    }
    const channelId = normalizeBindingChannelId(match.channel);
    if (!channelId) {
        return null;
    }
    const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
    if (!accountId || accountId === "*") {
        return null;
    }
    return {
        agentId: normalizeAgentId(binding.agentId),
        accountId: normalizeAccountId(accountId),
        channelId,
    };
}
export function listBoundAccountIds(cfg, channelId) {
    const normalizedChannel = normalizeBindingChannelId(channelId);
    if (!normalizedChannel) {
        return [];
    }
    const ids = new Set();
    for (const binding of listBindings(cfg)) {
        const resolved = resolveNormalizedBindingMatch(binding);
        if (!resolved || resolved.channelId !== normalizedChannel) {
            continue;
        }
        ids.add(resolved.accountId);
    }
    return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}
export function resolveDefaultAgentBoundAccountId(cfg, channelId) {
    const normalizedChannel = normalizeBindingChannelId(channelId);
    if (!normalizedChannel) {
        return null;
    }
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    for (const binding of listBindings(cfg)) {
        const resolved = resolveNormalizedBindingMatch(binding);
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
        const resolved = resolveNormalizedBindingMatch(binding);
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
