import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
export { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
export function resolvePairingPaths(baseDir, subdir) {
    const root = baseDir ?? resolveStateDir();
    const dir = path.join(root, subdir);
    return {
        dir,
        pendingPath: path.join(dir, "pending.json"),
        pairedPath: path.join(dir, "paired.json"),
    };
}
export function pruneExpiredPending(pendingById, nowMs, ttlMs) {
    for (const [id, req] of Object.entries(pendingById)) {
        if (nowMs - req.ts > ttlMs) {
            delete pendingById[id];
        }
    }
}
export async function upsertPendingPairingRequest(params) {
    const existing = Object.values(params.pendingById).find(params.isExisting);
    if (existing) {
        return { status: "pending", request: existing, created: false };
    }
    const request = params.createRequest(params.isRepair);
    params.pendingById[request.requestId] = request;
    await params.persist();
    return { status: "pending", request, created: true };
}
