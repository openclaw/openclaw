import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { generateSecureUuid } from "../secure-random.js";
const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
export function resolveQueueDir(stateDir) {
    const base = stateDir ?? resolveStateDir();
    return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
    return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    return {
        jsonPath: path.join(queueDir, `${id}.json`),
        deliveredPath: path.join(queueDir, `${id}.delivered`),
    };
}
function getErrnoCode(err) {
    return err && typeof err === "object" && "code" in err
        ? String(err.code)
        : null;
}
async function unlinkBestEffort(filePath) {
    try {
        await fs.promises.unlink(filePath);
    }
    catch {
        // Best-effort cleanup.
    }
}
async function writeQueueEntry(filePath, entry) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
    });
    await fs.promises.rename(tmp, filePath);
}
async function readQueueEntry(filePath) {
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
}
function normalizeLegacyQueuedDeliveryEntry(entry) {
    const hasAttemptTimestamp = typeof entry.lastAttemptAt === "number" &&
        Number.isFinite(entry.lastAttemptAt) &&
        entry.lastAttemptAt > 0;
    if (hasAttemptTimestamp || entry.retryCount <= 0) {
        return { entry, migrated: false };
    }
    const hasEnqueuedTimestamp = typeof entry.enqueuedAt === "number" &&
        Number.isFinite(entry.enqueuedAt) &&
        entry.enqueuedAt > 0;
    if (!hasEnqueuedTimestamp) {
        return { entry, migrated: false };
    }
    return {
        entry: {
            ...entry,
            lastAttemptAt: entry.enqueuedAt,
        },
        migrated: true,
    };
}
/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
    return queueDir;
}
/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
export async function enqueueDelivery(params, stateDir) {
    const queueDir = await ensureQueueDir(stateDir);
    const id = generateSecureUuid();
    await writeQueueEntry(path.join(queueDir, `${id}.json`), {
        id,
        enqueuedAt: Date.now(),
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        payloads: params.payloads,
        threadId: params.threadId,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        formatting: params.formatting,
        bestEffort: params.bestEffort,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        silent: params.silent,
        mirror: params.mirror,
        session: params.session,
        gatewayClientScopes: params.gatewayClientScopes,
        retryCount: 0,
    });
    return id;
}
/** Remove a successfully delivered entry from the queue.
 *
 * Uses a two-phase approach so that a crash between delivery and cleanup
 * does not cause the message to be replayed on the next recovery scan:
 *   Phase 1: atomic rename  {id}.json → {id}.delivered
 *   Phase 2: unlink the .delivered marker
 * If the process dies between phase 1 and phase 2 the marker is cleaned up
 * by {@link loadPendingDeliveries} on the next startup without re-sending.
 */
export async function ackDelivery(id, stateDir) {
    const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
    try {
        // Phase 1: atomic rename marks the delivery as complete.
        await fs.promises.rename(jsonPath, deliveredPath);
    }
    catch (err) {
        const code = getErrnoCode(err);
        if (code === "ENOENT") {
            // .json already gone — may have been renamed by a previous ack attempt.
            // Try to clean up a leftover .delivered marker if present.
            await unlinkBestEffort(deliveredPath);
            return;
        }
        throw err;
    }
    // Phase 2: remove the marker file.
    await unlinkBestEffort(deliveredPath);
}
/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id, error, stateDir) {
    const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
    const entry = await readQueueEntry(filePath);
    entry.retryCount += 1;
    entry.lastAttemptAt = Date.now();
    entry.lastError = error;
    await writeQueueEntry(filePath, entry);
}
/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(id, stateDir) {
    const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
    try {
        const stat = await fs.promises.stat(jsonPath);
        if (!stat.isFile()) {
            return null;
        }
        const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(await readQueueEntry(jsonPath));
        if (migrated) {
            await writeQueueEntry(jsonPath, entry);
        }
        return entry;
    }
    catch (err) {
        if (getErrnoCode(err) === "ENOENT") {
            return null;
        }
        throw err;
    }
}
/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    let files;
    try {
        files = await fs.promises.readdir(queueDir);
    }
    catch (err) {
        const code = getErrnoCode(err);
        if (code === "ENOENT") {
            return [];
        }
        throw err;
    }
    // Clean up .delivered markers left by ackDelivery if the process crashed
    // between the rename and the unlink.
    for (const file of files) {
        if (file.endsWith(".delivered")) {
            await unlinkBestEffort(path.join(queueDir, file));
        }
    }
    const entries = [];
    for (const file of files) {
        if (!file.endsWith(".json")) {
            continue;
        }
        const filePath = path.join(queueDir, file);
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) {
                continue;
            }
            const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(await readQueueEntry(filePath));
            if (migrated) {
                await writeQueueEntry(filePath, entry);
            }
            entries.push(entry);
        }
        catch {
            // Skip malformed or inaccessible entries.
        }
    }
    return entries;
}
/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id, stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    const failedDir = resolveFailedDir(stateDir);
    await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
    await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
