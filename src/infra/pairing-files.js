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
export async function reconcilePendingPairingRequests(params) {
    if (params.existing.length === 1 &&
        params.canRefreshSingle(params.existing[0], params.incoming)) {
        const refreshed = params.refreshSingle(params.existing[0], params.incoming);
        params.pendingById[refreshed.requestId] = refreshed;
        await params.persist();
        return { status: "pending", request: refreshed, created: false };
    }
    for (const existing of params.existing) {
        delete params.pendingById[existing.requestId];
    }
    const request = params.buildReplacement({
        existing: params.existing,
        incoming: params.incoming,
    });
    params.pendingById[request.requestId] = request;
    await params.persist();
    return { status: "pending", request, created: true };
}
