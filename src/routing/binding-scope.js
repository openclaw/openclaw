import { normalizeChatChannelId } from "../channels/ids.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";
export function normalizeRouteBindingId(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value).trim();
    }
    return "";
}
export function normalizeRouteBindingRoles(value) {
    return Array.isArray(value) && value.length > 0 ? value : null;
}
export function normalizeRouteBindingChannelId(raw) {
    const normalized = normalizeChatChannelId(raw);
    if (normalized) {
        return normalized;
    }
    const fallback = normalizeLowercaseStringOrEmpty(raw);
    return fallback || null;
}
export function resolveNormalizedRouteBindingMatch(binding) {
    if (!binding || typeof binding !== "object") {
        return null;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
        return null;
    }
    const channelId = normalizeRouteBindingChannelId(match.channel);
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
function scopeIdMatches(params) {
    if (!params.constraint) {
        return true;
    }
    return params.constraint === params.exact || params.constraint === params.groupSpace;
}
function hasRoleLookup(memberRoleIds) {
    return typeof memberRoleIds.has === "function";
}
function hasAnyRouteBindingRole(roles, memberRoleIds) {
    if (!memberRoleIds) {
        return false;
    }
    if (hasRoleLookup(memberRoleIds)) {
        return roles.some((role) => memberRoleIds.has(role));
    }
    const memberRoleIdSet = new Set(memberRoleIds);
    return roles.some((role) => memberRoleIdSet.has(role));
}
export function routeBindingScopeMatches(constraint, scope) {
    const guildId = normalizeRouteBindingId(scope.guildId);
    const teamId = normalizeRouteBindingId(scope.teamId);
    const groupSpace = normalizeRouteBindingId(scope.groupSpace);
    if (!scopeIdMatches({ constraint: constraint.guildId, exact: guildId, groupSpace })) {
        return false;
    }
    if (!scopeIdMatches({ constraint: constraint.teamId, exact: teamId, groupSpace })) {
        return false;
    }
    const roles = normalizeRouteBindingRoles(constraint.roles);
    if (!roles) {
        return true;
    }
    return hasAnyRouteBindingRole(roles, scope.memberRoleIds);
}
