import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { shouldLogVerbose } from "../globals.js";
import { logDebug } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeRouteBindingId, normalizeRouteBindingRoles, routeBindingScopeMatches, } from "./binding-scope.js";
import { listBindings } from "./bindings.js";
import { peerKindMatches } from "./peer-kind-match.js";
import { buildAgentMainSessionKey, buildAgentPeerSessionKey, DEFAULT_ACCOUNT_ID, DEFAULT_MAIN_KEY, normalizeAccountId, normalizeAgentId, sanitizeAgentId, } from "./session-key.js";
export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";
export function deriveLastRoutePolicy(params) {
    return params.sessionKey === params.mainSessionKey ? "main" : "session";
}
export function resolveInboundLastRouteSessionKey(params) {
    return params.route.lastRoutePolicy === "main" ? params.route.mainSessionKey : params.sessionKey;
}
function normalizeToken(value) {
    return normalizeLowercaseStringOrEmpty(value);
}
function normalizeId(value) {
    return normalizeRouteBindingId(value);
}
export function buildAgentSessionKey(params) {
    const channel = normalizeToken(params.channel) || "unknown";
    const peer = params.peer;
    return buildAgentPeerSessionKey({
        agentId: params.agentId,
        mainKey: DEFAULT_MAIN_KEY,
        channel,
        accountId: params.accountId,
        peerKind: peer?.kind ?? "direct",
        peerId: peer ? normalizeId(peer.id) || "unknown" : null,
        dmScope: params.dmScope,
        identityLinks: params.identityLinks,
    });
}
function listAgents(cfg) {
    const agents = cfg.agents?.list;
    return Array.isArray(agents) ? agents : [];
}
const agentLookupCacheByCfg = new WeakMap();
function resolveAgentLookupCache(cfg) {
    const agentsRef = cfg.agents;
    const existing = agentLookupCacheByCfg.get(cfg);
    if (existing && existing.agentsRef === agentsRef) {
        return existing;
    }
    const byNormalizedId = new Map();
    for (const agent of listAgents(cfg)) {
        const rawId = agent.id?.trim();
        if (!rawId) {
            continue;
        }
        byNormalizedId.set(normalizeAgentId(rawId), sanitizeAgentId(rawId));
    }
    const next = {
        agentsRef,
        byNormalizedId,
        fallbackDefaultAgentId: sanitizeAgentId(resolveDefaultAgentId(cfg)),
    };
    agentLookupCacheByCfg.set(cfg, next);
    return next;
}
export function pickFirstExistingAgentId(cfg, agentId) {
    const lookup = resolveAgentLookupCache(cfg);
    const trimmed = (agentId ?? "").trim();
    if (!trimmed) {
        return lookup.fallbackDefaultAgentId;
    }
    const normalized = normalizeAgentId(trimmed);
    if (lookup.byNormalizedId.size === 0) {
        return sanitizeAgentId(trimmed);
    }
    const resolved = lookup.byNormalizedId.get(normalized);
    if (resolved) {
        return resolved;
    }
    return lookup.fallbackDefaultAgentId;
}
const evaluatedBindingsCacheByCfg = new WeakMap();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2000;
const resolvedRouteCacheByCfg = new WeakMap();
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;
function resolveAccountPatternKey(accountPattern) {
    if (!accountPattern.trim()) {
        return DEFAULT_ACCOUNT_ID;
    }
    return normalizeAccountId(accountPattern);
}
function buildEvaluatedBindingsByChannel(cfg) {
    const byChannel = new Map();
    let order = 0;
    for (const binding of listBindings(cfg)) {
        if (!binding || typeof binding !== "object") {
            continue;
        }
        const channel = normalizeToken(binding.match?.channel);
        if (!channel) {
            continue;
        }
        const match = normalizeBindingMatch(binding.match);
        const evaluated = {
            binding,
            match,
            order,
        };
        order += 1;
        let bucket = byChannel.get(channel);
        if (!bucket) {
            bucket = {
                byAccount: new Map(),
                byAnyAccount: [],
            };
            byChannel.set(channel, bucket);
        }
        if (match.accountPattern === "*") {
            bucket.byAnyAccount.push(evaluated);
            continue;
        }
        const accountKey = resolveAccountPatternKey(match.accountPattern);
        const existing = bucket.byAccount.get(accountKey);
        if (existing) {
            existing.push(evaluated);
            continue;
        }
        bucket.byAccount.set(accountKey, [evaluated]);
    }
    return byChannel;
}
function mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount) {
    if (accountScoped.length === 0) {
        return anyAccount;
    }
    if (anyAccount.length === 0) {
        return accountScoped;
    }
    const merged = [];
    let accountIdx = 0;
    let anyIdx = 0;
    while (accountIdx < accountScoped.length && anyIdx < anyAccount.length) {
        const accountBinding = accountScoped[accountIdx];
        const anyBinding = anyAccount[anyIdx];
        if ((accountBinding?.order ?? Number.MAX_SAFE_INTEGER) <=
            (anyBinding?.order ?? Number.MAX_SAFE_INTEGER)) {
            if (accountBinding) {
                merged.push(accountBinding);
            }
            accountIdx += 1;
            continue;
        }
        if (anyBinding) {
            merged.push(anyBinding);
        }
        anyIdx += 1;
    }
    if (accountIdx < accountScoped.length) {
        merged.push(...accountScoped.slice(accountIdx));
    }
    if (anyIdx < anyAccount.length) {
        merged.push(...anyAccount.slice(anyIdx));
    }
    return merged;
}
function pushToIndexMap(map, key, binding) {
    if (!key) {
        return;
    }
    const existing = map.get(key);
    if (existing) {
        existing.push(binding);
        return;
    }
    map.set(key, [binding]);
}
function peerLookupKeys(kind, id) {
    if (kind === "group") {
        return [`group:${id}`, `channel:${id}`];
    }
    if (kind === "channel") {
        return [`channel:${id}`, `group:${id}`];
    }
    return [`${kind}:${id}`];
}
function collectPeerIndexedBindings(index, peer) {
    if (!peer) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const key of peerLookupKeys(peer.kind, peer.id)) {
        const matches = index.byPeer.get(key);
        if (!matches) {
            continue;
        }
        for (const match of matches) {
            if (seen.has(match)) {
                continue;
            }
            seen.add(match);
            out.push(match);
        }
    }
    return out;
}
function buildEvaluatedBindingsIndex(bindings) {
    const byPeer = new Map();
    const byPeerWildcard = [];
    const byGuildWithRoles = new Map();
    const byGuild = new Map();
    const byTeam = new Map();
    const byAccount = [];
    const byChannel = [];
    for (const binding of bindings) {
        if (binding.match.peer.state === "valid") {
            for (const key of peerLookupKeys(binding.match.peer.kind, binding.match.peer.id)) {
                pushToIndexMap(byPeer, key, binding);
            }
            continue;
        }
        if (binding.match.peer.state === "wildcard-kind") {
            byPeerWildcard.push(binding);
            continue;
        }
        if (binding.match.guildId && binding.match.roles) {
            pushToIndexMap(byGuildWithRoles, binding.match.guildId, binding);
            continue;
        }
        if (binding.match.guildId && !binding.match.roles) {
            pushToIndexMap(byGuild, binding.match.guildId, binding);
            continue;
        }
        if (binding.match.teamId) {
            pushToIndexMap(byTeam, binding.match.teamId, binding);
            continue;
        }
        if (binding.match.accountPattern !== "*") {
            byAccount.push(binding);
            continue;
        }
        byChannel.push(binding);
    }
    return {
        byPeer,
        byPeerWildcard,
        byGuildWithRoles,
        byGuild,
        byTeam,
        byAccount,
        byChannel,
    };
}
function getEvaluatedBindingsForChannelAccount(cfg, channel, accountId) {
    const bindingsRef = cfg.bindings;
    const existing = evaluatedBindingsCacheByCfg.get(cfg);
    const cache = existing && existing.bindingsRef === bindingsRef
        ? existing
        : {
            bindingsRef,
            byChannel: buildEvaluatedBindingsByChannel(cfg),
            byChannelAccount: new Map(),
            byChannelAccountIndex: new Map(),
        };
    if (cache !== existing) {
        evaluatedBindingsCacheByCfg.set(cfg, cache);
    }
    const cacheKey = `${channel}\t${accountId}`;
    const hit = cache.byChannelAccount.get(cacheKey);
    if (hit) {
        return hit;
    }
    const channelBindings = cache.byChannel.get(channel);
    const accountScoped = channelBindings?.byAccount.get(accountId) ?? [];
    const anyAccount = channelBindings?.byAnyAccount ?? [];
    const evaluated = mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount);
    cache.byChannelAccount.set(cacheKey, evaluated);
    cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
    if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
        cache.byChannelAccount.clear();
        cache.byChannelAccountIndex.clear();
        cache.byChannelAccount.set(cacheKey, evaluated);
        cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
    }
    return evaluated;
}
function getEvaluatedBindingIndexForChannelAccount(cfg, channel, accountId) {
    const bindings = getEvaluatedBindingsForChannelAccount(cfg, channel, accountId);
    const existing = evaluatedBindingsCacheByCfg.get(cfg);
    const cacheKey = `${channel}\t${accountId}`;
    const indexed = existing?.byChannelAccountIndex.get(cacheKey);
    if (indexed) {
        return indexed;
    }
    const built = buildEvaluatedBindingsIndex(bindings);
    existing?.byChannelAccountIndex.set(cacheKey, built);
    return built;
}
function normalizePeerConstraint(peer) {
    if (!peer) {
        return { state: "none" };
    }
    const kind = normalizeChatType(peer.kind);
    const id = normalizeId(peer.id);
    if (!kind || !id) {
        return { state: "invalid" };
    }
    if (id === "*") {
        return { state: "wildcard-kind", kind };
    }
    return { state: "valid", kind, id };
}
function normalizeBindingMatch(match) {
    const rawRoles = match?.roles;
    return {
        accountPattern: (match?.accountId ?? "").trim(),
        peer: normalizePeerConstraint(match?.peer),
        guildId: normalizeId(match?.guildId) || null,
        teamId: normalizeId(match?.teamId) || null,
        roles: normalizeRouteBindingRoles(rawRoles),
    };
}
function resolveRouteCacheForConfig(cfg) {
    const existing = resolvedRouteCacheByCfg.get(cfg);
    if (existing &&
        existing.bindingsRef === cfg.bindings &&
        existing.agentsRef === cfg.agents &&
        existing.sessionRef === cfg.session) {
        return existing.byKey;
    }
    const byKey = new Map();
    resolvedRouteCacheByCfg.set(cfg, {
        bindingsRef: cfg.bindings,
        agentsRef: cfg.agents,
        sessionRef: cfg.session,
        byKey,
    });
    return byKey;
}
function formatRouteCachePeer(peer) {
    if (!peer || !peer.id) {
        return "-";
    }
    return `${peer.kind}:${peer.id}`;
}
function formatRoleIdsCacheKey(roleIds) {
    const count = roleIds.length;
    if (count === 0) {
        return "-";
    }
    if (count === 1) {
        return roleIds[0] ?? "-";
    }
    if (count === 2) {
        const first = roleIds[0] ?? "";
        const second = roleIds[1] ?? "";
        return first <= second ? `${first},${second}` : `${second},${first}`;
    }
    return roleIds.toSorted().join(",");
}
function buildResolvedRouteCacheKey(params) {
    return `${params.channel}\t${params.accountId}\t${formatRouteCachePeer(params.peer)}\t${formatRouteCachePeer(params.parentPeer)}\t${params.guildId || "-"}\t${params.teamId || "-"}\t${formatRoleIdsCacheKey(params.memberRoleIds)}\t${params.dmScope}`;
}
function hasGuildConstraint(match) {
    return Boolean(match.guildId);
}
function hasTeamConstraint(match) {
    return Boolean(match.teamId);
}
function hasRolesConstraint(match) {
    return Boolean(match.roles);
}
function matchesBindingScope(match, scope) {
    if (match.peer.state === "invalid") {
        return false;
    }
    if (match.peer.state === "valid") {
        if (!scope.peer ||
            !peerKindMatches(match.peer.kind, scope.peer.kind) ||
            scope.peer.id !== match.peer.id) {
            return false;
        }
    }
    if (match.peer.state === "wildcard-kind") {
        if (!scope.peer || !peerKindMatches(match.peer.kind, scope.peer.kind)) {
            return false;
        }
    }
    return routeBindingScopeMatches(match, scope);
}
export function resolveAgentRoute(input) {
    const channel = normalizeToken(input.channel);
    const accountId = normalizeAccountId(input.accountId);
    const peer = input.peer
        ? {
            kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
            id: normalizeId(input.peer.id),
        }
        : null;
    const guildId = normalizeId(input.guildId);
    const teamId = normalizeId(input.teamId);
    const memberRoleIds = input.memberRoleIds ?? [];
    const memberRoleIdSet = new Set(memberRoleIds);
    const dmScope = input.cfg.session?.dmScope ?? "main";
    const identityLinks = input.cfg.session?.identityLinks;
    const shouldLogDebug = shouldLogVerbose();
    const parentPeer = input.parentPeer
        ? {
            kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
            id: normalizeId(input.parentPeer.id),
        }
        : null;
    const routeCache = !shouldLogDebug && !identityLinks ? resolveRouteCacheForConfig(input.cfg) : null;
    const routeCacheKey = routeCache
        ? buildResolvedRouteCacheKey({
            channel,
            accountId,
            peer,
            parentPeer,
            guildId,
            teamId,
            memberRoleIds,
            dmScope,
        })
        : "";
    if (routeCache && routeCacheKey) {
        const cachedRoute = routeCache.get(routeCacheKey);
        if (cachedRoute) {
            return { ...cachedRoute };
        }
    }
    const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
    const bindingsIndex = getEvaluatedBindingIndexForChannelAccount(input.cfg, channel, accountId);
    const choose = (agentId, matchedBy) => {
        const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
        const sessionKey = normalizeLowercaseStringOrEmpty(buildAgentSessionKey({
            agentId: resolvedAgentId,
            channel,
            accountId,
            peer,
            dmScope,
            identityLinks,
        }));
        const mainSessionKey = normalizeLowercaseStringOrEmpty(buildAgentMainSessionKey({
            agentId: resolvedAgentId,
            mainKey: DEFAULT_MAIN_KEY,
        }));
        const route = {
            agentId: resolvedAgentId,
            channel,
            accountId,
            sessionKey,
            mainSessionKey,
            lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
            matchedBy,
        };
        if (routeCache && routeCacheKey) {
            routeCache.set(routeCacheKey, route);
            if (routeCache.size > MAX_RESOLVED_ROUTE_CACHE_KEYS) {
                routeCache.clear();
                routeCache.set(routeCacheKey, route);
            }
        }
        return route;
    };
    const formatPeer = (value) => value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
    const formatNormalizedPeer = (value) => {
        if (value.state === "none") {
            return "none";
        }
        if (value.state === "invalid") {
            return "invalid";
        }
        if (value.state === "wildcard-kind") {
            return `${value.kind}:*`;
        }
        return `${value.kind}:${value.id}`;
    };
    if (shouldLogDebug) {
        logDebug(`[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`);
        for (const entry of bindings) {
            logDebug(`[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`);
        }
    }
    // Thread parent inheritance: if peer (thread) didn't match, check parent peer binding
    const baseScope = {
        guildId,
        teamId,
        memberRoleIds: memberRoleIdSet,
    };
    const tiers = [
        {
            matchedBy: "binding.peer",
            enabled: Boolean(peer),
            scopePeer: peer,
            candidates: collectPeerIndexedBindings(bindingsIndex, peer),
            predicate: (candidate) => candidate.match.peer.state === "valid",
        },
        {
            matchedBy: "binding.peer.parent",
            enabled: Boolean(parentPeer && parentPeer.id),
            scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
            candidates: collectPeerIndexedBindings(bindingsIndex, parentPeer),
            predicate: (candidate) => candidate.match.peer.state === "valid",
        },
        {
            matchedBy: "binding.peer.wildcard",
            enabled: Boolean(peer),
            scopePeer: peer,
            candidates: bindingsIndex.byPeerWildcard,
            predicate: (candidate) => candidate.match.peer.state === "wildcard-kind",
        },
        {
            matchedBy: "binding.guild+roles",
            enabled: Boolean(guildId && memberRoleIds.length > 0),
            scopePeer: peer,
            candidates: guildId ? (bindingsIndex.byGuildWithRoles.get(guildId) ?? []) : [],
            predicate: (candidate) => hasGuildConstraint(candidate.match) && hasRolesConstraint(candidate.match),
        },
        {
            matchedBy: "binding.guild",
            enabled: Boolean(guildId),
            scopePeer: peer,
            candidates: guildId ? (bindingsIndex.byGuild.get(guildId) ?? []) : [],
            predicate: (candidate) => hasGuildConstraint(candidate.match) && !hasRolesConstraint(candidate.match),
        },
        {
            matchedBy: "binding.team",
            enabled: Boolean(teamId),
            scopePeer: peer,
            candidates: teamId ? (bindingsIndex.byTeam.get(teamId) ?? []) : [],
            predicate: (candidate) => hasTeamConstraint(candidate.match),
        },
        {
            matchedBy: "binding.account",
            enabled: true,
            scopePeer: peer,
            candidates: bindingsIndex.byAccount,
            predicate: (candidate) => candidate.match.accountPattern !== "*",
        },
        {
            matchedBy: "binding.channel",
            enabled: true,
            scopePeer: peer,
            candidates: bindingsIndex.byChannel,
            predicate: (candidate) => candidate.match.accountPattern === "*",
        },
    ];
    for (const tier of tiers) {
        if (!tier.enabled) {
            continue;
        }
        const matched = tier.candidates.find((candidate) => tier.predicate(candidate) &&
            matchesBindingScope(candidate.match, {
                ...baseScope,
                peer: tier.scopePeer,
            }));
        if (matched) {
            if (shouldLogDebug) {
                logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
            }
            return choose(matched.binding.agentId, tier.matchedBy);
        }
    }
    return choose(resolveDefaultAgentId(input.cfg), "default");
}
