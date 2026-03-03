import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { generateSecureUuid } from "../secure-random.js";
const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const MAX_RETRIES = 5;
/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS = [
    5000, // retry 1: 5s
    25000, // retry 2: 25s
    120000, // retry 3: 2m
    600000, // retry 4: 10m
];
function resolveQueueDir(stateDir) {
    const base = stateDir ?? resolveStateDir();
    return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
    return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}
/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
    return queueDir;
}
export async function enqueueDelivery(params, stateDir) {
    const queueDir = await ensureQueueDir(stateDir);
    const id = generateSecureUuid();
    const entry = {
        id,
        enqueuedAt: Date.now(),
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        payloads: params.payloads,
        threadId: params.threadId,
        replyToId: params.replyToId,
        bestEffort: params.bestEffort,
        gifPlayback: params.gifPlayback,
        silent: params.silent,
        mirror: params.mirror,
        retryCount: 0,
    };
    const filePath = path.join(queueDir, `${id}.json`);
    const tmp = `${filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(entry, null, 2);
    await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
    return id;
}
/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id, stateDir) {
    const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
    try {
        await fs.promises.unlink(filePath);
    }
    catch (err) {
        const code = err && typeof err === "object" && "code" in err
            ? String(err.code)
            : null;
        if (code !== "ENOENT") {
            throw err;
        }
        // Already removed — no-op.
    }
}
/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id, error, stateDir) {
    const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const entry = JSON.parse(raw);
    entry.retryCount += 1;
    entry.lastAttemptAt = Date.now();
    entry.lastError = error;
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
    });
    await fs.promises.rename(tmp, filePath);
}
/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir) {
    const queueDir = resolveQueueDir(stateDir);
    let files;
    try {
        files = await fs.promises.readdir(queueDir);
    }
    catch (err) {
        const code = err && typeof err === "object" && "code" in err
            ? String(err.code)
            : null;
        if (code === "ENOENT") {
            return [];
        }
        throw err;
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
            const raw = await fs.promises.readFile(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(parsed);
            if (migrated) {
                const tmp = `${filePath}.${process.pid}.tmp`;
                await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
                    encoding: "utf-8",
                    mode: 0o600,
                });
                await fs.promises.rename(tmp, filePath);
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
    const src = path.join(queueDir, `${id}.json`);
    const dest = path.join(failedDir, `${id}.json`);
    await fs.promises.rename(src, dest);
}
/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount) {
    if (retryCount <= 0) {
        return 0;
    }
    return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}
export function isEntryEligibleForRecoveryRetry(entry, now) {
    const backoff = computeBackoffMs(entry.retryCount + 1);
    if (backoff <= 0) {
        return { eligible: true };
    }
    const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
    if (firstReplayAfterCrash) {
        return { eligible: true };
    }
    const hasAttemptTimestamp = typeof entry.lastAttemptAt === "number" &&
        Number.isFinite(entry.lastAttemptAt) &&
        entry.lastAttemptAt > 0;
    const baseAttemptAt = hasAttemptTimestamp
        ? (entry.lastAttemptAt ?? entry.enqueuedAt)
        : entry.enqueuedAt;
    const nextEligibleAt = baseAttemptAt + backoff;
    if (now >= nextEligibleAt) {
        return { eligible: true };
    }
    return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
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
/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts) {
    const pending = await loadPendingDeliveries(opts.stateDir);
    if (pending.length === 0) {
        return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
    }
    // Process oldest first.
    pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);
    const deadline = Date.now() + (opts.maxRecoveryMs ?? 60000);
    let recovered = 0;
    let failed = 0;
    let skippedMaxRetries = 0;
    let deferredBackoff = 0;
    for (const entry of pending) {
        const now = Date.now();
        if (now >= deadline) {
            const deferred = pending.length - recovered - failed - skippedMaxRetries - deferredBackoff;
            opts.log.warn(`Recovery time budget exceeded — ${deferred} entries deferred to next restart`);
            break;
        }
        if (entry.retryCount >= MAX_RETRIES) {
            opts.log.warn(`Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`);
            try {
                await moveToFailed(entry.id, opts.stateDir);
            }
            catch (err) {
                opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
            }
            skippedMaxRetries += 1;
            continue;
        }
        const retryEligibility = isEntryEligibleForRecoveryRetry(entry, now);
        if (!retryEligibility.eligible) {
            deferredBackoff += 1;
            opts.log.info(`Delivery ${entry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`);
            continue;
        }
        try {
            await opts.deliver({
                cfg: opts.cfg,
                channel: entry.channel,
                to: entry.to,
                accountId: entry.accountId,
                payloads: entry.payloads,
                threadId: entry.threadId,
                replyToId: entry.replyToId,
                bestEffort: entry.bestEffort,
                gifPlayback: entry.gifPlayback,
                silent: entry.silent,
                mirror: entry.mirror,
                skipQueue: true, // Prevent re-enqueueing during recovery
            });
            await ackDelivery(entry.id, opts.stateDir);
            recovered += 1;
            opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (isPermanentDeliveryError(errMsg)) {
                opts.log.warn(`Delivery ${entry.id} hit permanent error — moving to failed/: ${errMsg}`);
                try {
                    await moveToFailed(entry.id, opts.stateDir);
                }
                catch (moveErr) {
                    opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(moveErr)}`);
                }
                failed += 1;
                continue;
            }
            try {
                await failDelivery(entry.id, errMsg, opts.stateDir);
            }
            catch {
                // Best-effort update.
            }
            failed += 1;
            opts.log.warn(`Retry failed for delivery ${entry.id}: ${errMsg}`);
        }
    }
    opts.log.info(`Delivery recovery complete: ${recovered} recovered, ${failed} failed, ${skippedMaxRetries} skipped (max retries), ${deferredBackoff} deferred (backoff)`);
    return { recovered, failed, skippedMaxRetries, deferredBackoff };
}
export { MAX_RETRIES };
const PERMANENT_ERROR_PATTERNS = [
    /no conversation reference found/i,
    /chat not found/i,
    /user not found/i,
    /bot was blocked by the user/i,
    /forbidden: bot was kicked/i,
    /chat_id is empty/i,
    /recipient is not a valid/i,
    /outbound not configured for channel/i,
];
export function isPermanentDeliveryError(error) {
    return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
