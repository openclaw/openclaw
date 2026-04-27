import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
const log = createSubsystemLogger("outbound/pending-spawn");
const THROW_LOG_INTERVAL_MS = 60_000;
let lastThrowLogAt = 0;
let pendingSpawnedChildrenQuery;
export function registerPendingSpawnedChildrenQuery(query) {
    const previous = pendingSpawnedChildrenQuery;
    pendingSpawnedChildrenQuery = query;
    return previous;
}
function summarizeError(err) {
    if (err instanceof Error) {
        return { name: err.name, message: err.message };
    }
    return { name: "Unknown", message: typeof err === "string" ? err : "non-error throw" };
}
function hashSessionKey(key) {
    const trimmed = key?.trim();
    if (!trimmed) {
        return undefined;
    }
    return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}
export function resolvePendingSpawnedChildren(sessionKey) {
    if (!pendingSpawnedChildrenQuery) {
        return false;
    }
    try {
        return pendingSpawnedChildrenQuery(sessionKey);
    }
    catch (err) {
        const now = Date.now();
        if (now - lastThrowLogAt >= THROW_LOG_INTERVAL_MS) {
            lastThrowLogAt = now;
            log.warn("pending-spawn query threw; defaulting to false", {
                err: summarizeError(err),
                sessionKeyHash: hashSessionKey(sessionKey),
            });
        }
        return false;
    }
}
