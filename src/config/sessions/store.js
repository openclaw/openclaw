import fs from "node:fs";
import path from "node:path";
import { acquireSessionWriteLock, resolveSessionLockMaxHoldFromTimeout, } from "../../agents/session-write-lock.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deliveryContextFromSession, mergeDeliveryContext, normalizeDeliveryContext, normalizeSessionDeliveryFields, } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { dropSessionStoreObjectCache, getSerializedSessionStore, isSessionStoreCacheEnabled, setSerializedSessionStore, writeSessionStoreCache, } from "./store-cache.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import { loadSessionStore, normalizeSessionStore } from "./store-load.js";
import { LOCK_QUEUES, } from "./store-lock-state.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, rotateSessionFile, } from "./store-maintenance.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity, } from "./types.js";
export { clearSessionStoreCacheForTest, drainSessionStoreLockQueuesForTest, getSessionStoreLockQueueSizeForTest, } from "./store-lock-state.js";
export { loadSessionStore } from "./store-load.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise = null;
let sessionWriteLockAcquirerForTests = null;
function loadSessionArchiveRuntime() {
    sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
    return sessionArchiveRuntimePromise;
}
function removeThreadFromDeliveryContext(context) {
    if (!context || context.threadId == null) {
        return context;
    }
    const next = { ...context };
    delete next.threadId;
    return next;
}
export function setSessionWriteLockAcquirerForTests(acquirer) {
    sessionWriteLockAcquirerForTests = acquirer;
}
export function resetSessionStoreLockRuntimeForTests() {
    sessionWriteLockAcquirerForTests = null;
}
export async function withSessionStoreLockForTest(storePath, fn, opts = {}) {
    return await withSessionStoreLock(storePath, fn, opts);
}
export function readSessionUpdatedAt(params) {
    try {
        const store = loadSessionStore(params.storePath);
        const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
        return resolved.existing?.updatedAt;
    }
    catch {
        return undefined;
    }
}
export { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries, resolveMaintenanceConfig, rotateSessionFile, };
function updateSessionStoreWriteCaches(params) {
    const fileStat = getFileStatSnapshot(params.storePath);
    setSerializedSessionStore(params.storePath, params.serialized);
    if (!isSessionStoreCacheEnabled()) {
        dropSessionStoreObjectCache(params.storePath);
        return;
    }
    writeSessionStoreCache({
        storePath: params.storePath,
        store: params.store,
        mtimeMs: fileStat?.mtimeMs,
        sizeBytes: fileStat?.sizeBytes,
        serialized: params.serialized,
    });
}
function resolveMutableSessionStoreKey(store, sessionKey) {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
        return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(store, trimmed)) {
        return trimmed;
    }
    const normalized = normalizeStoreSessionKey(trimmed);
    if (Object.prototype.hasOwnProperty.call(store, normalized)) {
        return normalized;
    }
    return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}
function collectAcpMetadataSnapshot(store) {
    const snapshot = new Map();
    for (const [sessionKey, entry] of Object.entries(store)) {
        if (entry?.acp) {
            snapshot.set(sessionKey, entry.acp);
        }
    }
    return snapshot;
}
function preserveExistingAcpMetadata(params) {
    const allowDrop = new Set((params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)));
    for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
        const normalizedKey = normalizeStoreSessionKey(previousKey);
        if (allowDrop.has(normalizedKey)) {
            continue;
        }
        const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
        if (!nextKey) {
            continue;
        }
        const nextEntry = params.nextStore[nextKey];
        if (!nextEntry || nextEntry.acp) {
            continue;
        }
        params.nextStore[nextKey] = {
            ...nextEntry,
            acp: previousAcp,
        };
    }
}
async function saveSessionStoreUnlocked(storePath, store, opts) {
    normalizeSessionStore(store);
    if (!opts?.skipMaintenance) {
        // Resolve maintenance config once (avoids repeated loadConfig() calls).
        const maintenance = opts?.maintenanceConfig
            ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
            : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
        const shouldWarnOnly = maintenance.mode === "warn";
        const beforeCount = Object.keys(store).length;
        if (shouldWarnOnly) {
            const activeSessionKey = opts?.activeSessionKey?.trim();
            if (activeSessionKey) {
                const warning = getActiveSessionMaintenanceWarning({
                    store,
                    activeSessionKey,
                    pruneAfterMs: maintenance.pruneAfterMs,
                    maxEntries: maintenance.maxEntries,
                });
                if (warning) {
                    log.warn("session maintenance would evict active session; skipping enforcement", {
                        activeSessionKey: warning.activeSessionKey,
                        wouldPrune: warning.wouldPrune,
                        wouldCap: warning.wouldCap,
                        pruneAfterMs: warning.pruneAfterMs,
                        maxEntries: warning.maxEntries,
                    });
                    await opts?.onWarn?.(warning);
                }
            }
            const diskBudget = await enforceSessionDiskBudget({
                store,
                storePath,
                activeSessionKey: opts?.activeSessionKey,
                maintenance,
                warnOnly: true,
                log,
            });
            await opts?.onMaintenanceApplied?.({
                mode: maintenance.mode,
                beforeCount,
                afterCount: Object.keys(store).length,
                pruned: 0,
                capped: 0,
                diskBudget,
            });
        }
        else {
            const preserveSessionKeys = opts?.activeSessionKey
                ? new Set([opts.activeSessionKey])
                : undefined;
            // Prune stale entries and cap total count before serializing.
            const removedSessionFiles = new Map();
            const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
                onPruned: ({ entry }) => {
                    rememberRemovedSessionFile(removedSessionFiles, entry);
                },
                preserveKeys: preserveSessionKeys,
            });
            const capped = capEntryCount(store, maintenance.maxEntries, {
                onCapped: ({ entry }) => {
                    rememberRemovedSessionFile(removedSessionFiles, entry);
                },
                preserveKeys: preserveSessionKeys,
            });
            const archivedDirs = new Set();
            const referencedSessionIds = new Set(Object.values(store)
                .map((entry) => entry?.sessionId)
                .filter((id) => Boolean(id)));
            const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
                removedSessionFiles,
                referencedSessionIds,
                storePath,
                reason: "deleted",
                restrictToStoreDir: true,
            });
            for (const archivedDir of archivedForDeletedSessions) {
                archivedDirs.add(archivedDir);
            }
            if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
                const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
                const targetDirs = archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
                await cleanupArchivedSessionTranscripts({
                    directories: targetDirs,
                    olderThanMs: maintenance.pruneAfterMs,
                    reason: "deleted",
                });
                if (maintenance.resetArchiveRetentionMs != null) {
                    await cleanupArchivedSessionTranscripts({
                        directories: targetDirs,
                        olderThanMs: maintenance.resetArchiveRetentionMs,
                        reason: "reset",
                    });
                }
            }
            // Rotate the on-disk file if it exceeds the size threshold.
            await rotateSessionFile(storePath, maintenance.rotateBytes);
            const diskBudget = await enforceSessionDiskBudget({
                store,
                storePath,
                activeSessionKey: opts?.activeSessionKey,
                maintenance,
                warnOnly: false,
                log,
            });
            await opts?.onMaintenanceApplied?.({
                mode: maintenance.mode,
                beforeCount,
                afterCount: Object.keys(store).length,
                pruned,
                capped,
                diskBudget,
            });
        }
    }
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    const json = JSON.stringify(store, null, 2);
    if (getSerializedSessionStore(storePath) === json) {
        updateSessionStoreWriteCaches({ storePath, store, serialized: json });
        return;
    }
    // Windows: keep retry semantics because rename can fail while readers hold locks.
    if (process.platform === "win32") {
        for (let i = 0; i < 5; i++) {
            try {
                await writeSessionStoreAtomic({ storePath, store, serialized: json });
                return;
            }
            catch (err) {
                const code = getErrorCode(err);
                if (code === "ENOENT") {
                    return;
                }
                if (i < 4) {
                    await new Promise((r) => setTimeout(r, 50 * (i + 1)));
                    continue;
                }
                // Final attempt failed — skip this save. The write lock ensures
                // the next save will retry with fresh data. Log for diagnostics.
                log.warn(`atomic write failed after 5 attempts: ${storePath}`);
            }
        }
        return;
    }
    try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
    }
    catch (err) {
        const code = getErrorCode(err);
        if (code === "ENOENT") {
            // In tests the temp session-store directory may be deleted while writes are in-flight.
            // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
            try {
                await writeSessionStoreAtomic({ storePath, store, serialized: json });
            }
            catch (err2) {
                const code2 = getErrorCode(err2);
                if (code2 === "ENOENT") {
                    return;
                }
                throw err2;
            }
            return;
        }
        throw err;
    }
}
export async function saveSessionStore(storePath, store, opts) {
    await withSessionStoreLock(storePath, async () => {
        await saveSessionStoreUnlocked(storePath, store, opts);
    });
}
export async function updateSessionStore(storePath, mutator, opts) {
    return await withSessionStoreLock(storePath, async () => {
        // Always re-read inside the lock to avoid clobbering concurrent writers.
        const store = loadSessionStore(storePath, { skipCache: true });
        const previousAcpByKey = collectAcpMetadataSnapshot(store);
        const result = await mutator(store);
        preserveExistingAcpMetadata({
            previousAcpByKey,
            nextStore: store,
            allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
        });
        await saveSessionStoreUnlocked(storePath, store, opts);
        return result;
    });
}
const SESSION_STORE_LOCK_MIN_HOLD_MS = 5_000;
const SESSION_STORE_LOCK_TIMEOUT_GRACE_MS = 5_000;
function getErrorCode(error) {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return null;
    }
    return String(error.code);
}
function rememberRemovedSessionFile(removedSessionFiles, entry) {
    if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
        removedSessionFiles.set(entry.sessionId, entry.sessionFile);
    }
}
export async function archiveRemovedSessionTranscripts(params) {
    const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
    const archivedDirs = new Set();
    for (const [sessionId, sessionFile] of params.removedSessionFiles) {
        if (params.referencedSessionIds.has(sessionId)) {
            continue;
        }
        const archived = archiveSessionTranscripts({
            sessionId,
            storePath: params.storePath,
            sessionFile,
            reason: params.reason,
            restrictToStoreDir: params.restrictToStoreDir,
        });
        for (const archivedPath of archived) {
            archivedDirs.add(path.dirname(archivedPath));
        }
    }
    return archivedDirs;
}
async function writeSessionStoreAtomic(params) {
    await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
    updateSessionStoreWriteCaches({
        storePath: params.storePath,
        store: params.store,
        serialized: params.serialized,
    });
}
async function persistResolvedSessionEntry(params) {
    params.store[params.resolved.normalizedKey] = params.next;
    for (const legacyKey of params.resolved.legacyKeys) {
        delete params.store[legacyKey];
    }
    await saveSessionStoreUnlocked(params.storePath, params.store, {
        activeSessionKey: params.resolved.normalizedKey,
    });
    return params.next;
}
function lockTimeoutError(storePath) {
    return new Error(`timeout waiting for session store lock: ${storePath}`);
}
function resolveSessionStoreLockMaxHoldMs(timeoutMs) {
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return undefined;
    }
    return resolveSessionLockMaxHoldFromTimeout({
        timeoutMs,
        graceMs: SESSION_STORE_LOCK_TIMEOUT_GRACE_MS,
        minMs: SESSION_STORE_LOCK_MIN_HOLD_MS,
    });
}
function getOrCreateLockQueue(storePath) {
    const existing = LOCK_QUEUES.get(storePath);
    if (existing) {
        return existing;
    }
    const created = { running: false, pending: [], drainPromise: null };
    LOCK_QUEUES.set(storePath, created);
    return created;
}
async function drainSessionStoreLockQueue(storePath) {
    const queue = LOCK_QUEUES.get(storePath);
    if (!queue) {
        return;
    }
    if (queue.drainPromise) {
        await queue.drainPromise;
        return;
    }
    queue.running = true;
    queue.drainPromise = (async () => {
        try {
            while (queue.pending.length > 0) {
                const task = queue.pending.shift();
                if (!task) {
                    continue;
                }
                const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
                if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
                    task.reject(lockTimeoutError(storePath));
                    continue;
                }
                let lock;
                let result;
                let failed;
                let hasFailure = false;
                try {
                    lock = await (sessionWriteLockAcquirerForTests ?? acquireSessionWriteLock)({
                        sessionFile: storePath,
                        timeoutMs: remainingTimeoutMs,
                        staleMs: task.staleMs,
                        maxHoldMs: resolveSessionStoreLockMaxHoldMs(task.timeoutMs),
                    });
                    result = await task.fn();
                }
                catch (err) {
                    hasFailure = true;
                    failed = err;
                }
                finally {
                    await lock?.release().catch(() => undefined);
                }
                if (hasFailure) {
                    task.reject(failed);
                    continue;
                }
                task.resolve(result);
            }
        }
        finally {
            queue.running = false;
            queue.drainPromise = null;
            if (queue.pending.length === 0) {
                LOCK_QUEUES.delete(storePath);
            }
            else {
                queueMicrotask(() => {
                    void drainSessionStoreLockQueue(storePath);
                });
            }
        }
    })();
    await queue.drainPromise;
}
async function withSessionStoreLock(storePath, fn, opts = {}) {
    if (!storePath || typeof storePath !== "string") {
        throw new Error(`withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`);
    }
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const staleMs = opts.staleMs ?? 30_000;
    // `pollIntervalMs` is retained for API compatibility with older lock options.
    void opts.pollIntervalMs;
    const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
    const queue = getOrCreateLockQueue(storePath);
    const promise = new Promise((resolve, reject) => {
        const task = {
            fn: async () => await fn(),
            resolve: (value) => resolve(value),
            reject,
            timeoutMs: hasTimeout ? timeoutMs : undefined,
            staleMs,
        };
        queue.pending.push(task);
        void drainSessionStoreLockQueue(storePath);
    });
    return await promise;
}
export async function updateSessionStoreEntry(params) {
    const { storePath, sessionKey, update } = params;
    return await withSessionStoreLock(storePath, async () => {
        const store = loadSessionStore(storePath, { skipCache: true });
        const resolved = resolveSessionStoreEntry({ store, sessionKey });
        const existing = resolved.existing;
        if (!existing) {
            return null;
        }
        const patch = await update(existing);
        if (!patch) {
            return existing;
        }
        const next = mergeSessionEntry(existing, patch);
        return await persistResolvedSessionEntry({
            storePath,
            store,
            resolved,
            next,
        });
    });
}
export async function recordSessionMetaFromInbound(params) {
    const { storePath, sessionKey, ctx } = params;
    const createIfMissing = params.createIfMissing ?? true;
    return await updateSessionStore(storePath, (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey });
        const existing = resolved.existing;
        const patch = deriveSessionMetaPatch({
            ctx,
            sessionKey: resolved.normalizedKey,
            existing,
            groupResolution: params.groupResolution,
        });
        if (!patch) {
            if (existing && resolved.legacyKeys.length > 0) {
                store[resolved.normalizedKey] = existing;
                for (const legacyKey of resolved.legacyKeys) {
                    delete store[legacyKey];
                }
            }
            return existing ?? null;
        }
        if (!existing && !createIfMissing) {
            return null;
        }
        const next = existing
            ? // Inbound metadata updates must not refresh activity timestamps;
                // idle reset evaluation relies on updatedAt from actual session turns.
                mergeSessionEntryPreserveActivity(existing, patch)
            : mergeSessionEntry(existing, patch);
        store[resolved.normalizedKey] = next;
        for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
        }
        return next;
    }, { activeSessionKey: normalizeStoreSessionKey(sessionKey) });
}
export async function updateLastRoute(params) {
    const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
    return await withSessionStoreLock(storePath, async () => {
        const store = loadSessionStore(storePath);
        const resolved = resolveSessionStoreEntry({ store, sessionKey });
        const existing = resolved.existing;
        const explicitContext = normalizeDeliveryContext(params.deliveryContext);
        const inlineContext = normalizeDeliveryContext({
            channel,
            to,
            accountId,
            threadId,
        });
        const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
        const explicitDeliveryContext = params.deliveryContext;
        const explicitThreadFromDeliveryContext = explicitDeliveryContext != null &&
            Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
            ? explicitDeliveryContext.threadId
            : undefined;
        const explicitThreadValue = explicitThreadFromDeliveryContext ??
            (threadId != null && threadId !== "" ? threadId : undefined);
        const explicitRouteProvided = Boolean(explicitContext?.channel ||
            explicitContext?.to ||
            inlineContext?.channel ||
            inlineContext?.to);
        const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
        const fallbackContext = clearThreadFromFallback
            ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
            : deliveryContextFromSession(existing);
        const merged = mergeDeliveryContext(mergedInput, fallbackContext);
        const normalized = normalizeSessionDeliveryFields({
            deliveryContext: {
                channel: merged?.channel,
                to: merged?.to,
                accountId: merged?.accountId,
                threadId: merged?.threadId,
            },
        });
        const metaPatch = ctx
            ? deriveSessionMetaPatch({
                ctx,
                sessionKey: resolved.normalizedKey,
                existing,
                groupResolution: params.groupResolution,
            })
            : null;
        const basePatch = {
            deliveryContext: normalized.deliveryContext,
            lastChannel: normalized.lastChannel,
            lastTo: normalized.lastTo,
            lastAccountId: normalized.lastAccountId,
            lastThreadId: normalized.lastThreadId,
        };
        // Route updates must not refresh activity timestamps; idle/daily reset
        // evaluation relies on updatedAt from actual session turns (#49515).
        const next = mergeSessionEntryPreserveActivity(existing, metaPatch ? { ...basePatch, ...metaPatch } : basePatch);
        return await persistResolvedSessionEntry({
            storePath,
            store,
            resolved,
            next,
        });
    });
}
