import { randomUUID } from "node:crypto";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { createAsyncLock, pruneExpiredPending, readJsonFile, resolvePairingPaths, writeJsonAtomic, } from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";
const PENDING_TTL_MS = 5 * 60 * 1000;
const withLock = createAsyncLock();
async function loadState(baseDir) {
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
    const [pending, paired] = await Promise.all([
        readJsonFile(pendingPath),
        readJsonFile(pairedPath),
    ]);
    const state = {
        pendingById: pending ?? {},
        pairedByDeviceId: paired ?? {},
    };
    pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
    return state;
}
async function persistState(state, baseDir) {
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
    await Promise.all([
        writeJsonAtomic(pendingPath, state.pendingById),
        writeJsonAtomic(pairedPath, state.pairedByDeviceId),
    ]);
}
function normalizeDeviceId(deviceId) {
    return deviceId.trim();
}
function normalizeRole(role) {
    const trimmed = role?.trim();
    return trimmed ? trimmed : null;
}
function mergeRoles(...items) {
    const roles = new Set();
    for (const item of items) {
        if (!item) {
            continue;
        }
        if (Array.isArray(item)) {
            for (const role of item) {
                const trimmed = role.trim();
                if (trimmed) {
                    roles.add(trimmed);
                }
            }
        }
        else {
            const trimmed = item.trim();
            if (trimmed) {
                roles.add(trimmed);
            }
        }
    }
    if (roles.size === 0) {
        return undefined;
    }
    return [...roles];
}
function mergeScopes(...items) {
    const scopes = new Set();
    for (const item of items) {
        if (!item) {
            continue;
        }
        for (const scope of item) {
            const trimmed = scope.trim();
            if (trimmed) {
                scopes.add(trimmed);
            }
        }
    }
    if (scopes.size === 0) {
        return undefined;
    }
    return [...scopes];
}
function mergePendingDevicePairingRequest(existing, incoming, isRepair) {
    const existingRole = normalizeRole(existing.role);
    const incomingRole = normalizeRole(incoming.role);
    return {
        ...existing,
        displayName: incoming.displayName ?? existing.displayName,
        platform: incoming.platform ?? existing.platform,
        deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
        clientId: incoming.clientId ?? existing.clientId,
        clientMode: incoming.clientMode ?? existing.clientMode,
        role: existingRole ?? incomingRole ?? undefined,
        roles: mergeRoles(existing.roles, existing.role, incoming.role),
        scopes: mergeScopes(existing.scopes, incoming.scopes),
        remoteIp: incoming.remoteIp ?? existing.remoteIp,
        // If either request is interactive, keep the pending request visible for approval.
        silent: Boolean(existing.silent && incoming.silent),
        isRepair: existing.isRepair || isRepair,
        ts: Date.now(),
    };
}
function scopesAllow(requested, allowed) {
    if (requested.length === 0) {
        return true;
    }
    if (allowed.length === 0) {
        return false;
    }
    const allowedSet = new Set(allowed);
    return requested.every((scope) => allowedSet.has(scope));
}
const DEVICE_SCOPE_IMPLICATIONS = {
    "operator.admin": ["operator.read", "operator.write", "operator.approvals", "operator.pairing"],
    "operator.write": ["operator.read"],
};
function expandScopeImplications(scopes) {
    const expanded = new Set(scopes);
    const queue = [...scopes];
    while (queue.length > 0) {
        const scope = queue.pop();
        if (!scope) {
            continue;
        }
        for (const impliedScope of DEVICE_SCOPE_IMPLICATIONS[scope] ?? []) {
            if (!expanded.has(impliedScope)) {
                expanded.add(impliedScope);
                queue.push(impliedScope);
            }
        }
    }
    return [...expanded];
}
function scopesAllowWithImplications(requested, allowed) {
    return scopesAllow(expandScopeImplications(requested), expandScopeImplications(allowed));
}
function newToken() {
    return generatePairingToken();
}
function getPairedDeviceFromState(state, deviceId) {
    return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}
function cloneDeviceTokens(device) {
    return device.tokens ? { ...device.tokens } : {};
}
function buildDeviceAuthToken(params) {
    return {
        token: newToken(),
        role: params.role,
        scopes: params.scopes,
        createdAtMs: params.existing?.createdAtMs ?? params.now,
        rotatedAtMs: params.rotatedAtMs,
        revokedAtMs: undefined,
        lastUsedAtMs: params.existing?.lastUsedAtMs,
    };
}
export async function listDevicePairing(baseDir) {
    const state = await loadState(baseDir);
    const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
    const paired = Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs);
    return { pending, paired };
}
export async function getPairedDevice(deviceId, baseDir) {
    const state = await loadState(baseDir);
    return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}
export async function requestDevicePairing(req, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const deviceId = normalizeDeviceId(req.deviceId);
        if (!deviceId) {
            throw new Error("deviceId required");
        }
        const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
        const existing = Object.values(state.pendingById).find((pending) => pending.deviceId === deviceId);
        if (existing) {
            const merged = mergePendingDevicePairingRequest(existing, req, isRepair);
            state.pendingById[existing.requestId] = merged;
            await persistState(state, baseDir);
            return { status: "pending", request: merged, created: false };
        }
        const request = {
            requestId: randomUUID(),
            deviceId,
            publicKey: req.publicKey,
            displayName: req.displayName,
            platform: req.platform,
            deviceFamily: req.deviceFamily,
            clientId: req.clientId,
            clientMode: req.clientMode,
            role: req.role,
            roles: req.role ? [req.role] : undefined,
            scopes: req.scopes,
            remoteIp: req.remoteIp,
            silent: req.silent,
            isRepair,
            ts: Date.now(),
        };
        state.pendingById[request.requestId] = request;
        await persistState(state, baseDir);
        return { status: "pending", request, created: true };
    });
}
export async function approveDevicePairing(requestId, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const pending = state.pendingById[requestId];
        if (!pending) {
            return null;
        }
        const now = Date.now();
        const existing = state.pairedByDeviceId[pending.deviceId];
        const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
        const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
        const tokens = existing?.tokens ? { ...existing.tokens } : {};
        const roleForToken = normalizeRole(pending.role);
        if (roleForToken) {
            const existingToken = tokens[roleForToken];
            const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
            const nextScopes = requestedScopes.length > 0
                ? requestedScopes
                : normalizeDeviceAuthScopes(existingToken?.scopes ??
                    approvedScopes ??
                    existing?.approvedScopes ??
                    existing?.scopes);
            const now = Date.now();
            tokens[roleForToken] = {
                token: newToken(),
                role: roleForToken,
                scopes: nextScopes,
                createdAtMs: existingToken?.createdAtMs ?? now,
                rotatedAtMs: existingToken ? now : undefined,
                revokedAtMs: undefined,
                lastUsedAtMs: existingToken?.lastUsedAtMs,
            };
        }
        const device = {
            deviceId: pending.deviceId,
            publicKey: pending.publicKey,
            displayName: pending.displayName,
            platform: pending.platform,
            deviceFamily: pending.deviceFamily,
            clientId: pending.clientId,
            clientMode: pending.clientMode,
            role: pending.role,
            roles,
            scopes: approvedScopes,
            approvedScopes,
            remoteIp: pending.remoteIp,
            tokens,
            createdAtMs: existing?.createdAtMs ?? now,
            approvedAtMs: now,
        };
        delete state.pendingById[requestId];
        state.pairedByDeviceId[device.deviceId] = device;
        await persistState(state, baseDir);
        return { requestId, device };
    });
}
export async function rejectDevicePairing(requestId, baseDir) {
    return await withLock(async () => {
        return await rejectPendingPairingRequest({
            requestId,
            idKey: "deviceId",
            loadState: () => loadState(baseDir),
            persistState: (state) => persistState(state, baseDir),
            getId: (pending) => pending.deviceId,
        });
    });
}
export async function removePairedDevice(deviceId, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const normalized = normalizeDeviceId(deviceId);
        if (!normalized || !state.pairedByDeviceId[normalized]) {
            return null;
        }
        delete state.pairedByDeviceId[normalized];
        await persistState(state, baseDir);
        return { deviceId: normalized };
    });
}
export async function updatePairedDeviceMetadata(deviceId, patch, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const existing = state.pairedByDeviceId[normalizeDeviceId(deviceId)];
        if (!existing) {
            return;
        }
        const roles = mergeRoles(existing.roles, existing.role, patch.role);
        const scopes = mergeScopes(existing.scopes, patch.scopes);
        state.pairedByDeviceId[deviceId] = {
            ...existing,
            ...patch,
            deviceId: existing.deviceId,
            createdAtMs: existing.createdAtMs,
            approvedAtMs: existing.approvedAtMs,
            approvedScopes: existing.approvedScopes,
            role: patch.role ?? existing.role,
            roles,
            scopes,
        };
        await persistState(state, baseDir);
    });
}
export function summarizeDeviceTokens(tokens) {
    if (!tokens) {
        return undefined;
    }
    const summaries = Object.values(tokens)
        .map((token) => ({
        role: token.role,
        scopes: token.scopes,
        createdAtMs: token.createdAtMs,
        rotatedAtMs: token.rotatedAtMs,
        revokedAtMs: token.revokedAtMs,
        lastUsedAtMs: token.lastUsedAtMs,
    }))
        .toSorted((a, b) => a.role.localeCompare(b.role));
    return summaries.length > 0 ? summaries : undefined;
}
export async function verifyDeviceToken(params) {
    return await withLock(async () => {
        const state = await loadState(params.baseDir);
        const device = getPairedDeviceFromState(state, params.deviceId);
        if (!device) {
            return { ok: false, reason: "device-not-paired" };
        }
        const role = normalizeRole(params.role);
        if (!role) {
            return { ok: false, reason: "role-missing" };
        }
        const entry = device.tokens?.[role];
        if (!entry) {
            return { ok: false, reason: "token-missing" };
        }
        if (entry.revokedAtMs) {
            return { ok: false, reason: "token-revoked" };
        }
        if (!verifyPairingToken(params.token, entry.token)) {
            return { ok: false, reason: "token-mismatch" };
        }
        const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
        if (!roleScopesAllow({ role, requestedScopes, allowedScopes: entry.scopes })) {
            return { ok: false, reason: "scope-mismatch" };
        }
        entry.lastUsedAtMs = Date.now();
        device.tokens ??= {};
        device.tokens[role] = entry;
        state.pairedByDeviceId[device.deviceId] = device;
        await persistState(state, params.baseDir);
        return { ok: true };
    });
}
export async function ensureDeviceToken(params) {
    return await withLock(async () => {
        const state = await loadState(params.baseDir);
        const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
        const context = resolveDeviceTokenUpdateContext({
            state,
            deviceId: params.deviceId,
            role: params.role,
        });
        if (!context) {
            return null;
        }
        const { device, role, tokens, existing } = context;
        if (existing && !existing.revokedAtMs) {
            if (roleScopesAllow({ role, requestedScopes, allowedScopes: existing.scopes })) {
                return existing;
            }
        }
        const now = Date.now();
        const next = buildDeviceAuthToken({
            role,
            scopes: requestedScopes,
            existing,
            now,
            rotatedAtMs: existing ? now : undefined,
        });
        tokens[role] = next;
        device.tokens = tokens;
        state.pairedByDeviceId[device.deviceId] = device;
        await persistState(state, params.baseDir);
        return next;
    });
}
function resolveDeviceTokenUpdateContext(params) {
    const device = getPairedDeviceFromState(params.state, params.deviceId);
    if (!device) {
        return null;
    }
    const role = normalizeRole(params.role);
    if (!role) {
        return null;
    }
    const tokens = cloneDeviceTokens(device);
    const existing = tokens[role];
    return { device, role, tokens, existing };
}
export async function rotateDeviceToken(params) {
    return await withLock(async () => {
        const state = await loadState(params.baseDir);
        const context = resolveDeviceTokenUpdateContext({
            state,
            deviceId: params.deviceId,
            role: params.role,
        });
        if (!context) {
            return null;
        }
        const { device, role, tokens, existing } = context;
        const requestedScopes = normalizeDeviceAuthScopes(params.scopes ?? existing?.scopes ?? device.scopes);
        const approvedScopes = normalizeDeviceAuthScopes(device.approvedScopes ?? device.scopes ?? existing?.scopes);
        if (!scopesAllowWithImplications(requestedScopes, approvedScopes)) {
            return null;
        }
        const now = Date.now();
        const next = buildDeviceAuthToken({
            role,
            scopes: requestedScopes,
            existing,
            now,
            rotatedAtMs: now,
        });
        tokens[role] = next;
        device.tokens = tokens;
        state.pairedByDeviceId[device.deviceId] = device;
        await persistState(state, params.baseDir);
        return next;
    });
}
export async function revokeDeviceToken(params) {
    return await withLock(async () => {
        const state = await loadState(params.baseDir);
        const device = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
        if (!device) {
            return null;
        }
        const role = normalizeRole(params.role);
        if (!role) {
            return null;
        }
        if (!device.tokens?.[role]) {
            return null;
        }
        const tokens = { ...device.tokens };
        const entry = { ...tokens[role], revokedAtMs: Date.now() };
        tokens[role] = entry;
        device.tokens = tokens;
        state.pairedByDeviceId[device.deviceId] = device;
        await persistState(state, params.baseDir);
        return entry;
    });
}
export async function clearDevicePairing(deviceId, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const normalizedId = normalizeDeviceId(deviceId);
        if (!state.pairedByDeviceId[normalizedId]) {
            return false;
        }
        delete state.pairedByDeviceId[normalizedId];
        await persistState(state, baseDir);
        return true;
    });
}
