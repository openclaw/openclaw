import fs from "node:fs";
import path from "node:path";
import { isPrimarySessionTranscriptFileName, isSessionArchiveArtifactName } from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
const NOOP_LOGGER = {
    warn: () => { },
    info: () => { },
};
function canonicalizePathForComparison(filePath) {
    const resolved = path.resolve(filePath);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
function measureStoreBytes(store) {
    return Buffer.byteLength(JSON.stringify(store, null, 2), "utf-8");
}
function measureStoreEntryChunkBytes(key, entry) {
    const singleEntryStore = JSON.stringify({ [key]: entry }, null, 2);
    if (!singleEntryStore.startsWith("{\n") || !singleEntryStore.endsWith("\n}")) {
        return measureStoreBytes({ [key]: entry }) - 4;
    }
    const chunk = singleEntryStore.slice(2, -2);
    return Buffer.byteLength(chunk, "utf-8");
}
function buildStoreEntryChunkSizeMap(store) {
    const out = new Map();
    for (const [key, entry] of Object.entries(store)) {
        out.set(key, measureStoreEntryChunkBytes(key, entry));
    }
    return out;
}
function getEntryUpdatedAt(entry) {
    if (!entry) {
        return 0;
    }
    const updatedAt = entry.updatedAt;
    return Number.isFinite(updatedAt) ? updatedAt : 0;
}
function buildSessionIdRefCounts(store) {
    const counts = new Map();
    for (const entry of Object.values(store)) {
        const sessionId = entry?.sessionId;
        if (!sessionId) {
            continue;
        }
        counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    }
    return counts;
}
function resolveSessionTranscriptPathForEntry(params) {
    if (!params.entry.sessionId) {
        return null;
    }
    try {
        const resolved = resolveSessionFilePath(params.entry.sessionId, params.entry, {
            sessionsDir: params.sessionsDir,
        });
        const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
        const resolvedPath = canonicalizePathForComparison(resolved);
        const relative = path.relative(resolvedSessionsDir, resolvedPath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            return null;
        }
        return resolvedPath;
    }
    catch {
        return null;
    }
}
function resolveReferencedSessionTranscriptPaths(params) {
    const referenced = new Set();
    for (const entry of Object.values(params.store)) {
        const resolved = resolveSessionTranscriptPathForEntry({
            sessionsDir: params.sessionsDir,
            entry,
        });
        if (resolved) {
            referenced.add(canonicalizePathForComparison(resolved));
        }
    }
    return referenced;
}
async function readSessionsDirFiles(sessionsDir) {
    const dirEntries = await fs.promises
        .readdir(sessionsDir, { withFileTypes: true })
        .catch(() => []);
    const files = [];
    for (const dirent of dirEntries) {
        if (!dirent.isFile()) {
            continue;
        }
        const filePath = path.join(sessionsDir, dirent.name);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat?.isFile()) {
            continue;
        }
        files.push({
            path: filePath,
            canonicalPath: canonicalizePathForComparison(filePath),
            name: dirent.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        });
    }
    return files;
}
async function removeFileIfExists(filePath) {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
        return 0;
    }
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    return stat.size;
}
async function removeFileForBudget(params) {
    const resolvedPath = path.resolve(params.filePath);
    const canonicalPath = params.canonicalPath ?? canonicalizePathForComparison(resolvedPath);
    if (params.dryRun) {
        if (params.simulatedRemovedPaths.has(canonicalPath)) {
            return 0;
        }
        const size = params.fileSizesByPath.get(canonicalPath) ?? 0;
        if (size <= 0) {
            return 0;
        }
        params.simulatedRemovedPaths.add(canonicalPath);
        return size;
    }
    return removeFileIfExists(resolvedPath);
}
export async function enforceSessionDiskBudget(params) {
    const maxBytes = params.maintenance.maxDiskBytes;
    const highWaterBytes = params.maintenance.highWaterBytes;
    if (maxBytes == null || highWaterBytes == null) {
        return null;
    }
    const log = params.log ?? NOOP_LOGGER;
    const dryRun = params.dryRun === true;
    const sessionsDir = path.dirname(params.storePath);
    const files = await readSessionsDirFiles(sessionsDir);
    const fileSizesByPath = new Map(files.map((file) => [file.canonicalPath, file.size]));
    const simulatedRemovedPaths = new Set();
    const resolvedStorePath = canonicalizePathForComparison(params.storePath);
    const storeFile = files.find((file) => file.canonicalPath === resolvedStorePath);
    let projectedStoreBytes = measureStoreBytes(params.store);
    let total = files.reduce((sum, file) => sum + file.size, 0) - (storeFile?.size ?? 0) + projectedStoreBytes;
    const totalBefore = total;
    if (total <= maxBytes) {
        return {
            totalBytesBefore: totalBefore,
            totalBytesAfter: total,
            removedFiles: 0,
            removedEntries: 0,
            freedBytes: 0,
            maxBytes,
            highWaterBytes,
            overBudget: false,
        };
    }
    if (params.warnOnly) {
        log.warn("session disk budget exceeded (warn-only mode)", {
            sessionsDir,
            totalBytes: total,
            maxBytes,
            highWaterBytes,
        });
        return {
            totalBytesBefore: totalBefore,
            totalBytesAfter: total,
            removedFiles: 0,
            removedEntries: 0,
            freedBytes: 0,
            maxBytes,
            highWaterBytes,
            overBudget: true,
        };
    }
    let removedFiles = 0;
    let removedEntries = 0;
    let freedBytes = 0;
    const referencedPaths = resolveReferencedSessionTranscriptPaths({
        sessionsDir,
        store: params.store,
    });
    const removableFileQueue = files
        .filter((file) => isSessionArchiveArtifactName(file.name) ||
        (isPrimarySessionTranscriptFileName(file.name) && !referencedPaths.has(file.canonicalPath)))
        .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of removableFileQueue) {
        if (total <= highWaterBytes) {
            break;
        }
        const deletedBytes = await removeFileForBudget({
            filePath: file.path,
            canonicalPath: file.canonicalPath,
            dryRun,
            fileSizesByPath,
            simulatedRemovedPaths,
        });
        if (deletedBytes <= 0) {
            continue;
        }
        total -= deletedBytes;
        freedBytes += deletedBytes;
        removedFiles += 1;
    }
    if (total > highWaterBytes) {
        const activeSessionKey = params.activeSessionKey?.trim().toLowerCase();
        const sessionIdRefCounts = buildSessionIdRefCounts(params.store);
        const entryChunkBytesByKey = buildStoreEntryChunkSizeMap(params.store);
        const keys = Object.keys(params.store).toSorted((a, b) => {
            const aTime = getEntryUpdatedAt(params.store[a]);
            const bTime = getEntryUpdatedAt(params.store[b]);
            return aTime - bTime;
        });
        for (const key of keys) {
            if (total <= highWaterBytes) {
                break;
            }
            if (activeSessionKey && key.trim().toLowerCase() === activeSessionKey) {
                continue;
            }
            const entry = params.store[key];
            if (!entry) {
                continue;
            }
            const previousProjectedBytes = projectedStoreBytes;
            delete params.store[key];
            const chunkBytes = entryChunkBytesByKey.get(key);
            entryChunkBytesByKey.delete(key);
            if (typeof chunkBytes === "number" && Number.isFinite(chunkBytes) && chunkBytes >= 0) {
                // Removing any one pretty-printed top-level entry always removes the entry chunk plus ",\n" (2 bytes).
                projectedStoreBytes = Math.max(2, projectedStoreBytes - (chunkBytes + 2));
            }
            else {
                projectedStoreBytes = measureStoreBytes(params.store);
            }
            total += projectedStoreBytes - previousProjectedBytes;
            removedEntries += 1;
            const sessionId = entry.sessionId;
            if (!sessionId) {
                continue;
            }
            const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 1) - 1;
            if (nextRefCount > 0) {
                sessionIdRefCounts.set(sessionId, nextRefCount);
                continue;
            }
            sessionIdRefCounts.delete(sessionId);
            const transcriptPath = resolveSessionTranscriptPathForEntry({ sessionsDir, entry });
            if (!transcriptPath) {
                continue;
            }
            const deletedBytes = await removeFileForBudget({
                filePath: transcriptPath,
                dryRun,
                fileSizesByPath,
                simulatedRemovedPaths,
            });
            if (deletedBytes <= 0) {
                continue;
            }
            total -= deletedBytes;
            freedBytes += deletedBytes;
            removedFiles += 1;
        }
    }
    if (!dryRun) {
        if (total > highWaterBytes) {
            log.warn("session disk budget still above high-water target after cleanup", {
                sessionsDir,
                totalBytes: total,
                maxBytes,
                highWaterBytes,
                removedFiles,
                removedEntries,
            });
        }
        else if (removedFiles > 0 || removedEntries > 0) {
            log.info("applied session disk budget cleanup", {
                sessionsDir,
                totalBytesBefore: totalBefore,
                totalBytesAfter: total,
                maxBytes,
                highWaterBytes,
                removedFiles,
                removedEntries,
            });
        }
    }
    return {
        totalBytesBefore: totalBefore,
        totalBytesAfter: total,
        removedFiles,
        removedEntries,
        freedBytes,
        maxBytes,
        highWaterBytes,
        overBudget: true,
    };
}
