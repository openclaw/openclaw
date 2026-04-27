import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { listSpawnedSessionKeys, sessionVisibilityGatewayTesting, } from "../../plugin-sdk/session-visibility.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
const defaultSessionsResolutionDeps = {
    callGateway,
};
let sessionsResolutionDeps = defaultSessionsResolutionDeps;
export function resolveMainSessionAlias(cfg) {
    const mainKey = normalizeMainKey(cfg.session?.mainKey);
    const scope = cfg.session?.scope ?? "per-sender";
    const alias = scope === "global" ? "global" : mainKey;
    return { mainKey, alias, scope };
}
export function resolveDisplaySessionKey(params) {
    if (params.key === params.alias) {
        return "main";
    }
    if (params.key === params.mainKey) {
        return "main";
    }
    return params.key;
}
export function resolveInternalSessionKey(params) {
    if (params.key === "current") {
        return params.requesterInternalKey ?? params.key;
    }
    if (params.key === "main") {
        return params.alias;
    }
    return params.key;
}
export { listSpawnedSessionKeys };
export async function isRequesterSpawnedSessionVisible(params) {
    if (params.requesterSessionKey === params.targetSessionKey) {
        return true;
    }
    try {
        const resolved = await sessionsResolutionDeps.callGateway({
            method: "sessions.resolve",
            params: {
                key: params.targetSessionKey,
                spawnedBy: params.requesterSessionKey,
            },
        });
        if (typeof resolved?.key === "string" && resolved.key.trim() === params.targetSessionKey) {
            return true;
        }
    }
    catch {
        // Fall back to the spawned-session listing path below.
    }
    const keys = await listSpawnedSessionKeys({
        requesterSessionKey: params.requesterSessionKey,
        limit: params.limit,
    });
    return keys.has(params.targetSessionKey);
}
export function shouldVerifyRequesterSpawnedSessionVisibility(params) {
    return (params.restrictToSpawned &&
        !params.resolvedViaSessionId &&
        params.requesterSessionKey !== params.targetSessionKey);
}
export async function isResolvedSessionVisibleToRequester(params) {
    if (!shouldVerifyRequesterSpawnedSessionVisibility({
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey: params.targetSessionKey,
        restrictToSpawned: params.restrictToSpawned,
        resolvedViaSessionId: params.resolvedViaSessionId,
    })) {
        return true;
    }
    return await isRequesterSpawnedSessionVisible({
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey: params.targetSessionKey,
        limit: params.limit,
    });
}
export { looksLikeSessionId };
export function looksLikeSessionKey(value) {
    const raw = normalizeOptionalString(value) ?? "";
    if (!raw) {
        return false;
    }
    // These are canonical key shapes that should never be treated as sessionIds.
    if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") {
        return true;
    }
    if (isAcpSessionKey(raw)) {
        return true;
    }
    if (raw.startsWith("agent:")) {
        return true;
    }
    if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
        return true;
    }
    if (raw.startsWith("node-") || raw.startsWith("node:")) {
        return true;
    }
    if (raw.includes(":group:") || raw.includes(":channel:")) {
        return true;
    }
    return false;
}
export function shouldResolveSessionIdInput(value) {
    // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
    return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}
function buildResolvedSessionReference(params) {
    return {
        ok: true,
        key: params.key,
        displayKey: resolveDisplaySessionKey({
            key: params.key,
            alias: params.alias,
            mainKey: params.mainKey,
        }),
        resolvedViaSessionId: params.resolvedViaSessionId,
    };
}
function buildSessionIdResolveParams(params) {
    return {
        sessionId: params.sessionId,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
        includeGlobal: !params.restrictToSpawned,
        includeUnknown: !params.restrictToSpawned,
    };
}
async function callGatewayResolveSessionId(params) {
    const result = await sessionsResolutionDeps.callGateway({
        method: "sessions.resolve",
        params: buildSessionIdResolveParams(params),
    });
    const key = normalizeOptionalString(result?.key) ?? "";
    if (!key) {
        throw new Error(`Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`);
    }
    return key;
}
async function resolveSessionKeyFromSessionId(params) {
    try {
        // Resolve via gateway so we respect store routing and visibility rules.
        const key = await callGatewayResolveSessionId(params);
        return buildResolvedSessionReference({
            key,
            alias: params.alias,
            mainKey: params.mainKey,
            resolvedViaSessionId: true,
        });
    }
    catch (err) {
        if (params.restrictToSpawned) {
            return {
                ok: false,
                status: "forbidden",
                error: `Session not visible from this sandboxed agent session: ${params.sessionId}`,
            };
        }
        const message = formatErrorMessage(err);
        return {
            ok: false,
            status: "error",
            error: message ||
                `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
        };
    }
}
async function resolveSessionKeyFromKey(params) {
    try {
        // Try key-based resolution first so non-standard keys keep working.
        const result = await sessionsResolutionDeps.callGateway({
            method: "sessions.resolve",
            params: {
                key: params.key,
                spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
            },
        });
        const key = normalizeOptionalString(result?.key) ?? "";
        if (!key) {
            return null;
        }
        return buildResolvedSessionReference({
            key,
            alias: params.alias,
            mainKey: params.mainKey,
            resolvedViaSessionId: false,
        });
    }
    catch {
        return null;
    }
}
async function tryResolveSessionKeyFromSessionId(params) {
    try {
        const key = await callGatewayResolveSessionId(params);
        return buildResolvedSessionReference({
            key,
            alias: params.alias,
            mainKey: params.mainKey,
            resolvedViaSessionId: true,
        });
    }
    catch {
        return null;
    }
}
async function resolveSessionReferenceByKeyOrSessionId(params) {
    if (!params.skipKeyLookup) {
        // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
        const resolvedByKey = await resolveSessionKeyFromKey({
            key: params.raw,
            alias: params.alias,
            mainKey: params.mainKey,
            requesterInternalKey: params.requesterInternalKey,
            restrictToSpawned: params.restrictToSpawned,
        });
        if (resolvedByKey) {
            return resolvedByKey;
        }
    }
    if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) {
        return null;
    }
    if (params.allowUnresolvedSessionId) {
        return await tryResolveSessionKeyFromSessionId({
            sessionId: params.raw,
            alias: params.alias,
            mainKey: params.mainKey,
            requesterInternalKey: params.requesterInternalKey,
            restrictToSpawned: params.restrictToSpawned,
        });
    }
    return await resolveSessionKeyFromSessionId({
        sessionId: params.raw,
        alias: params.alias,
        mainKey: params.mainKey,
        requesterInternalKey: params.requesterInternalKey,
        restrictToSpawned: params.restrictToSpawned,
    });
}
export async function resolveSessionReference(params) {
    const rawInput = params.sessionKey.trim();
    if (rawInput === "current") {
        const resolvedCurrent = await resolveSessionReferenceByKeyOrSessionId({
            raw: rawInput,
            alias: params.alias,
            mainKey: params.mainKey,
            requesterInternalKey: params.requesterInternalKey,
            restrictToSpawned: params.restrictToSpawned,
            allowUnresolvedSessionId: true,
            skipKeyLookup: params.restrictToSpawned,
            forceSessionIdLookup: true,
        });
        if (resolvedCurrent) {
            return resolvedCurrent;
        }
    }
    const raw = rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
    if (shouldResolveSessionIdInput(raw)) {
        const resolvedByGateway = await resolveSessionReferenceByKeyOrSessionId({
            raw,
            alias: params.alias,
            mainKey: params.mainKey,
            requesterInternalKey: params.requesterInternalKey,
            restrictToSpawned: params.restrictToSpawned,
            allowUnresolvedSessionId: false,
        });
        if (resolvedByGateway) {
            return resolvedByGateway;
        }
    }
    const resolvedKey = resolveInternalSessionKey({
        key: raw,
        alias: params.alias,
        mainKey: params.mainKey,
        requesterInternalKey: params.requesterInternalKey,
    });
    const displayKey = resolveDisplaySessionKey({
        key: resolvedKey,
        alias: params.alias,
        mainKey: params.mainKey,
    });
    return { ok: true, key: resolvedKey, displayKey, resolvedViaSessionId: false };
}
export async function resolveVisibleSessionReference(params) {
    const resolvedKey = params.resolvedSession.key;
    const displayKey = params.resolvedSession.displayKey;
    const visible = await isResolvedSessionVisibleToRequester({
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey: resolvedKey,
        restrictToSpawned: params.restrictToSpawned,
        resolvedViaSessionId: params.resolvedSession.resolvedViaSessionId,
    });
    if (!visible) {
        return {
            ok: false,
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
            displayKey,
        };
    }
    return { ok: true, key: resolvedKey, displayKey };
}
export const normalizeOptionalKey = normalizeOptionalString;
export const __testing = {
    setDepsForTest(overrides) {
        sessionsResolutionDeps = overrides
            ? {
                ...defaultSessionsResolutionDeps,
                ...overrides,
            }
            : defaultSessionsResolutionDeps;
        sessionVisibilityGatewayTesting.setCallGatewayForListSpawned(overrides?.callGateway ?? defaultSessionsResolutionDeps.callGateway);
    },
};
