import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";
import { getPath } from "./path-utils.js";
import { getCoreSecretTargetRegistry, getSecretTargetRegistry } from "./target-registry-data.js";
import { compileTargetRegistryEntry, expandPathTokens, materializePathTokens, matchPathTokens, } from "./target-registry-pattern.js";
let compiledSecretTargetRegistryState = null;
let compiledCoreOpenClawTargetState = null;
const compiledBundledChannelOpenClawTargets = new Map();
function buildTargetTypeIndex(compiledSecretTargetRegistry) {
    const byType = new Map();
    const append = (type, entry) => {
        const existing = byType.get(type);
        if (existing) {
            existing.push(entry);
            return;
        }
        byType.set(type, [entry]);
    };
    for (const entry of compiledSecretTargetRegistry) {
        append(entry.targetType, entry);
        for (const alias of entry.targetTypeAliases ?? []) {
            append(alias, entry);
        }
    }
    return byType;
}
function buildConfigTargetIdIndex(entries) {
    const byId = new Map();
    for (const entry of entries) {
        const existing = byId.get(entry.id);
        if (existing) {
            existing.push(entry);
            continue;
        }
        byId.set(entry.id, [entry]);
    }
    return byId;
}
function getCompiledSecretTargetRegistryState() {
    if (compiledSecretTargetRegistryState) {
        return compiledSecretTargetRegistryState;
    }
    const compiledSecretTargetRegistry = getSecretTargetRegistry().map(compileTargetRegistryEntry);
    const openClawCompiledSecretTargets = compiledSecretTargetRegistry.filter((entry) => entry.configFile === "openclaw.json");
    const authProfilesCompiledSecretTargets = compiledSecretTargetRegistry.filter((entry) => entry.configFile === "auth-profiles.json");
    compiledSecretTargetRegistryState = {
        authProfilesCompiledSecretTargets,
        authProfilesTargetsById: buildConfigTargetIdIndex(authProfilesCompiledSecretTargets),
        compiledSecretTargetRegistry,
        knownTargetIds: new Set(compiledSecretTargetRegistry.map((entry) => entry.id)),
        openClawCompiledSecretTargets,
        openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
        targetsByType: buildTargetTypeIndex(compiledSecretTargetRegistry),
    };
    return compiledSecretTargetRegistryState;
}
function getCompiledCoreOpenClawTargetState() {
    if (compiledCoreOpenClawTargetState) {
        return compiledCoreOpenClawTargetState;
    }
    const openClawCompiledSecretTargets = getCoreSecretTargetRegistry()
        .filter((entry) => entry.configFile === "openclaw.json")
        .map(compileTargetRegistryEntry);
    compiledCoreOpenClawTargetState = {
        knownTargetIds: new Set(openClawCompiledSecretTargets.map((entry) => entry.id)),
        openClawCompiledSecretTargets,
        openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
        targetsByType: buildTargetTypeIndex(openClawCompiledSecretTargets),
    };
    return compiledCoreOpenClawTargetState;
}
function getCompiledBundledChannelOpenClawTargets(channelId) {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
        return null;
    }
    if (compiledBundledChannelOpenClawTargets.has(normalizedChannelId)) {
        return compiledBundledChannelOpenClawTargets.get(normalizedChannelId) ?? null;
    }
    const compiledEntries = loadBundledChannelSecretContractApi(normalizedChannelId)
        ?.secretTargetRegistryEntries?.filter((entry) => entry.configFile === "openclaw.json")
        .map(compileTargetRegistryEntry) ?? null;
    compiledBundledChannelOpenClawTargets.set(normalizedChannelId, compiledEntries);
    return compiledEntries;
}
function normalizeAllowedTargetIds(targetIds) {
    if (targetIds === undefined) {
        return null;
    }
    return new Set(Array.from(targetIds)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0));
}
function resolveDiscoveryEntries(params) {
    if (params.allowedTargetIds === null) {
        return params.defaultEntries;
    }
    return Array.from(params.allowedTargetIds).flatMap((targetId) => params.entriesById.get(targetId) ?? []);
}
function discoverSecretTargetsFromEntries(source, discoveryEntries) {
    const out = [];
    const seen = new Set();
    for (const entry of discoveryEntries) {
        const expanded = expandPathTokens(source, entry.pathTokens);
        for (const match of expanded) {
            const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
            if (!resolved) {
                continue;
            }
            const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const refValue = resolved.refPathSegments
                ? getPath(source, resolved.refPathSegments)
                : undefined;
            out.push({
                entry,
                path: resolved.pathSegments.join("."),
                pathSegments: resolved.pathSegments,
                ...(resolved.refPathSegments
                    ? {
                        refPathSegments: resolved.refPathSegments,
                        refPath: resolved.refPathSegments.join("."),
                    }
                    : {}),
                value: match.value,
                ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
                ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
                ...(resolved.refPathSegments ? { refValue } : {}),
            });
        }
    }
    return out;
}
function toResolvedPlanTarget(entry, pathSegments, captures) {
    const providerId = entry.providerIdPathSegmentIndex !== undefined
        ? pathSegments[entry.providerIdPathSegmentIndex]
        : undefined;
    const accountId = entry.accountIdPathSegmentIndex !== undefined
        ? pathSegments[entry.accountIdPathSegmentIndex]
        : undefined;
    const refPathSegments = entry.refPathTokens
        ? materializePathTokens(entry.refPathTokens, captures)
        : undefined;
    if (entry.refPathTokens && !refPathSegments) {
        return null;
    }
    return {
        entry,
        pathSegments,
        ...(refPathSegments ? { refPathSegments } : {}),
        ...(providerId ? { providerId } : {}),
        ...(accountId ? { accountId } : {}),
    };
}
export function listSecretTargetRegistryEntries() {
    return getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry.map((entry) => Object.assign({ id: entry.id, targetType: entry.targetType }, entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {}, { configFile: entry.configFile, pathPattern: entry.pathPattern }, entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {}, {
        secretShape: entry.secretShape,
        expectedResolvedValue: entry.expectedResolvedValue,
        includeInPlan: entry.includeInPlan,
        includeInConfigure: entry.includeInConfigure,
        includeInAudit: entry.includeInAudit,
    }, entry.providerIdPathSegmentIndex !== undefined
        ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex }
        : {}, entry.accountIdPathSegmentIndex !== undefined
        ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex }
        : {}, entry.authProfileType ? { authProfileType: entry.authProfileType } : {}, entry.trackProviderShadowing ? { trackProviderShadowing: true } : {}));
}
export function isKnownSecretTargetType(value) {
    return (typeof value === "string" && getCompiledSecretTargetRegistryState().targetsByType.has(value));
}
export function isKnownSecretTargetId(value) {
    return (typeof value === "string" && getCompiledSecretTargetRegistryState().knownTargetIds.has(value));
}
export function resolvePlanTargetAgainstRegistry(candidate) {
    const coreEntries = getCompiledCoreOpenClawTargetState().targetsByType.get(candidate.type);
    if (coreEntries) {
        return resolvePlanTargetAgainstEntries(candidate, coreEntries);
    }
    const entries = getCompiledSecretTargetRegistryState().targetsByType.get(candidate.type);
    return resolvePlanTargetAgainstEntries(candidate, entries);
}
function resolvePlanTargetAgainstEntries(candidate, entries) {
    if (!entries || entries.length === 0) {
        return null;
    }
    for (const entry of entries) {
        if (!entry.includeInPlan) {
            continue;
        }
        const matched = matchPathTokens(candidate.pathSegments, entry.pathTokens);
        if (!matched) {
            continue;
        }
        const resolved = toResolvedPlanTarget(entry, candidate.pathSegments, matched.captures);
        if (!resolved) {
            continue;
        }
        if (candidate.providerId && candidate.providerId.trim().length > 0) {
            if (!resolved.providerId || resolved.providerId !== candidate.providerId) {
                continue;
            }
        }
        if (candidate.accountId && candidate.accountId.trim().length > 0) {
            if (!resolved.accountId || resolved.accountId !== candidate.accountId) {
                continue;
            }
        }
        return resolved;
    }
    return null;
}
export function resolveConfigSecretTargetByPath(pathSegments) {
    for (const entry of getCompiledCoreOpenClawTargetState().openClawCompiledSecretTargets) {
        if (!entry.includeInPlan) {
            continue;
        }
        const matched = matchPathTokens(pathSegments, entry.pathTokens);
        if (!matched) {
            continue;
        }
        const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
        if (!resolved) {
            continue;
        }
        return resolved;
    }
    const explicitBundledChannelId = pathSegments[0] === "channels" ? (pathSegments[1]?.trim() ?? "") : "";
    const explicitBundledChannelEntries = explicitBundledChannelId
        ? getCompiledBundledChannelOpenClawTargets(explicitBundledChannelId)
        : null;
    for (const entry of explicitBundledChannelEntries ?? []) {
        if (!entry.includeInPlan) {
            continue;
        }
        const matched = matchPathTokens(pathSegments, entry.pathTokens);
        if (!matched) {
            continue;
        }
        const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
        if (!resolved) {
            continue;
        }
        return resolved;
    }
    for (const entry of getCompiledSecretTargetRegistryState().openClawCompiledSecretTargets) {
        if (!entry.includeInPlan) {
            continue;
        }
        const matched = matchPathTokens(pathSegments, entry.pathTokens);
        if (!matched) {
            continue;
        }
        const resolved = toResolvedPlanTarget(entry, pathSegments, matched.captures);
        if (!resolved) {
            continue;
        }
        return resolved;
    }
    return null;
}
export function discoverConfigSecretTargets(config) {
    return discoverConfigSecretTargetsByIds(config);
}
export function discoverConfigSecretTargetsByIds(config, targetIds) {
    const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
    const registryState = allowedTargetIds !== null &&
        Array.from(allowedTargetIds).every((targetId) => getCompiledCoreOpenClawTargetState().knownTargetIds.has(targetId))
        ? getCompiledCoreOpenClawTargetState()
        : getCompiledSecretTargetRegistryState();
    const discoveryEntries = resolveDiscoveryEntries({
        allowedTargetIds,
        defaultEntries: registryState.openClawCompiledSecretTargets,
        entriesById: registryState.openClawTargetsById,
    });
    return discoverSecretTargetsFromEntries(config, discoveryEntries);
}
export function discoverAuthProfileSecretTargets(store) {
    return discoverAuthProfileSecretTargetsByIds(store);
}
export function discoverAuthProfileSecretTargetsByIds(store, targetIds) {
    const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
    const registryState = getCompiledSecretTargetRegistryState();
    const discoveryEntries = resolveDiscoveryEntries({
        allowedTargetIds,
        defaultEntries: registryState.authProfilesCompiledSecretTargets,
        entriesById: registryState.authProfilesTargetsById,
    });
    return discoverSecretTargetsFromEntries(store, discoveryEntries);
}
export function listAuthProfileSecretTargetEntries() {
    return getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry.filter((entry) => entry.configFile === "auth-profiles.json" && entry.includeInAudit);
}
