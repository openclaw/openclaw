import { randomUUID } from "node:crypto";
import { createAsyncLock, pruneExpiredPending, readJsonFile, resolvePairingPaths, upsertPendingPairingRequest, writeJsonAtomic, } from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";
const PENDING_TTL_MS = 5 * 60 * 1000;
const withLock = createAsyncLock();
async function loadState(baseDir) {
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
    const [pending, paired] = await Promise.all([
        readJsonFile(pendingPath),
        readJsonFile(pairedPath),
    ]);
    const state = {
        pendingById: pending ?? {},
        pairedByNodeId: paired ?? {},
    };
    pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
    return state;
}
async function persistState(state, baseDir) {
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
    await Promise.all([
        writeJsonAtomic(pendingPath, state.pendingById),
        writeJsonAtomic(pairedPath, state.pairedByNodeId),
    ]);
}
function normalizeNodeId(nodeId) {
    return nodeId.trim();
}
function newToken() {
    return generatePairingToken();
}
export async function listNodePairing(baseDir) {
    const state = await loadState(baseDir);
    const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
    const paired = Object.values(state.pairedByNodeId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs);
    return { pending, paired };
}
export async function getPairedNode(nodeId, baseDir) {
    const state = await loadState(baseDir);
    return state.pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}
export async function requestNodePairing(req, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const nodeId = normalizeNodeId(req.nodeId);
        if (!nodeId) {
            throw new Error("nodeId required");
        }
        return await upsertPendingPairingRequest({
            pendingById: state.pendingById,
            isExisting: (pending) => pending.nodeId === nodeId,
            isRepair: Boolean(state.pairedByNodeId[nodeId]),
            createRequest: (isRepair) => ({
                requestId: randomUUID(),
                nodeId,
                displayName: req.displayName,
                platform: req.platform,
                version: req.version,
                coreVersion: req.coreVersion,
                uiVersion: req.uiVersion,
                deviceFamily: req.deviceFamily,
                modelIdentifier: req.modelIdentifier,
                caps: req.caps,
                commands: req.commands,
                permissions: req.permissions,
                remoteIp: req.remoteIp,
                silent: req.silent,
                isRepair,
                ts: Date.now(),
            }),
            persist: async () => await persistState(state, baseDir),
        });
    });
}
export async function approveNodePairing(requestId, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const pending = state.pendingById[requestId];
        if (!pending) {
            return null;
        }
        const now = Date.now();
        const existing = state.pairedByNodeId[pending.nodeId];
        const node = {
            nodeId: pending.nodeId,
            token: newToken(),
            displayName: pending.displayName,
            platform: pending.platform,
            version: pending.version,
            coreVersion: pending.coreVersion,
            uiVersion: pending.uiVersion,
            deviceFamily: pending.deviceFamily,
            modelIdentifier: pending.modelIdentifier,
            caps: pending.caps,
            commands: pending.commands,
            permissions: pending.permissions,
            remoteIp: pending.remoteIp,
            createdAtMs: existing?.createdAtMs ?? now,
            approvedAtMs: now,
        };
        delete state.pendingById[requestId];
        state.pairedByNodeId[pending.nodeId] = node;
        await persistState(state, baseDir);
        return { requestId, node };
    });
}
export async function rejectNodePairing(requestId, baseDir) {
    return await withLock(async () => {
        return await rejectPendingPairingRequest({
            requestId,
            idKey: "nodeId",
            loadState: () => loadState(baseDir),
            persistState: (state) => persistState(state, baseDir),
            getId: (pending) => pending.nodeId,
        });
    });
}
export async function verifyNodeToken(nodeId, token, baseDir) {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const node = state.pairedByNodeId[normalized];
    if (!node) {
        return { ok: false };
    }
    return verifyPairingToken(token, node.token) ? { ok: true, node } : { ok: false };
}
export async function updatePairedNodeMetadata(nodeId, patch, baseDir) {
    await withLock(async () => {
        const state = await loadState(baseDir);
        const normalized = normalizeNodeId(nodeId);
        const existing = state.pairedByNodeId[normalized];
        if (!existing) {
            return;
        }
        const next = {
            ...existing,
            displayName: patch.displayName ?? existing.displayName,
            platform: patch.platform ?? existing.platform,
            version: patch.version ?? existing.version,
            coreVersion: patch.coreVersion ?? existing.coreVersion,
            uiVersion: patch.uiVersion ?? existing.uiVersion,
            deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
            modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
            remoteIp: patch.remoteIp ?? existing.remoteIp,
            caps: patch.caps ?? existing.caps,
            commands: patch.commands ?? existing.commands,
            bins: patch.bins ?? existing.bins,
            permissions: patch.permissions ?? existing.permissions,
            lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
        };
        state.pairedByNodeId[normalized] = next;
        await persistState(state, baseDir);
    });
}
export async function renamePairedNode(nodeId, displayName, baseDir) {
    return await withLock(async () => {
        const state = await loadState(baseDir);
        const normalized = normalizeNodeId(nodeId);
        const existing = state.pairedByNodeId[normalized];
        if (!existing) {
            return null;
        }
        const trimmed = displayName.trim();
        if (!trimmed) {
            throw new Error("displayName required");
        }
        const next = { ...existing, displayName: trimmed };
        state.pairedByNodeId[normalized] = next;
        await persistState(state, baseDir);
        return next;
    });
}
