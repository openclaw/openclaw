import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { resolveOagDeliveryMaxRetries, resolveOagDeliveryRecoveryBudgetMs } from "../oag-config.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundMirror } from "./mirror.js";
import { addToIndex, removeFromIndex, rebuildIndex } from "./delivery-index.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

export type DeliveryLanePriority = "user-visible" | "internal-followup";
type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  lanePriority?: DeliveryLanePriority;
  mirror?: OutboundMirror;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export type RecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

type RecoveryFilterOptions = {
  channel?: Exclude<OutboundChannel, "none">;
  accountId?: string;
};

function resolveLanePriority(params: QueuedDeliveryPayload): DeliveryLanePriority {
  if (params.lanePriority) {
    return params.lanePriority;
  }
  if (params.silent) {
    return "internal-followup";
  }
  if (params.mirror?.sessionKey?.trim()) {
    return "user-visible";
  }
  return "user-visible";
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

function resolveQueueEntryPaths(
  id: string,
  stateDir?: string,
): {
  jsonPath: string;
  deliveredPath: string;
} {
  const queueDir = resolveQueueDir(stateDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = QueuedDeliveryPayload;

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = generateSecureUuid();
  const entry: QueuedDelivery = {
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
    forceDocument: params.forceDocument,
    silent: params.silent,
    lanePriority: resolveLanePriority(params),
    mirror: params.mirror,
    retryCount: 0,
  };
  const filePath = path.join(queueDir, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(entry, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
  try {
    addToIndex(
      {
        id,
        channel: params.channel,
        accountId: params.accountId,
        enqueuedAt: entry.enqueuedAt,
        lanePriority: entry.lanePriority ?? "user-visible",
      },
      stateDir,
    );
  } catch {
    // Best-effort index update — queue file is the source of truth
  }
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
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    // Phase 1: atomic rename marks the delivery as complete.
    await fs.promises.rename(jsonPath, deliveredPath);
  } catch (err) {
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
  try {
    removeFromIndex(id, stateDir);
  } catch {
    // Best-effort
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
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

export async function updateDeliveryPayloads(
  id: string,
  payloads: ReplyPayload[],
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
  entry.payloads = payloads;
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  // Clean up .delivered markers left by ackDelivery if the process crashed
  // between the rename and the unlink.
  for (const file of files) {
    if (!file.endsWith(".delivered")) {
      continue;
    }
    await unlinkBestEffort(path.join(queueDir, file));
  }

  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file === "index.json") {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as QueuedDelivery;
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
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

export async function hasPendingUserVisibleDeliveries(params?: {
  stateDir?: string;
  excludeId?: string | null;
}): Promise<boolean> {
  const pending = await loadPendingDeliveries(params?.stateDir);
  return pending.some(
    (entry) =>
      entry.id !== params?.excludeId && (entry.lanePriority ?? "user-visible") === "user-visible",
  );
}

function lanePriorityWeight(priority: DeliveryLanePriority | undefined): number {
  return priority === "internal-followup" ? 1 : 0;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const src = path.join(queueDir, `${id}.json`);
  const dest = path.join(failedDir, `${id}.json`);
  await fs.promises.rename(src, dest);
  try {
    removeFromIndex(id, stateDir);
  } catch {
    // Best-effort
  }
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
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

function normalizeLegacyQueuedDeliveryEntry(entry: QueuedDelivery): {
  entry: QueuedDelivery;
  migrated: boolean;
} {
  let migrated = false;
  let next = entry;
  if (!entry.lanePriority) {
    next = {
      ...next,
      lanePriority: resolveLanePriority(entry),
    };
    migrated = true;
  }
  const hasAttemptTimestamp =
    typeof next.lastAttemptAt === "number" &&
    Number.isFinite(next.lastAttemptAt) &&
    next.lastAttemptAt > 0;
  if (hasAttemptTimestamp || next.retryCount <= 0) {
    return { entry: next, migrated };
  }
  const hasEnqueuedTimestamp =
    typeof next.enqueuedAt === "number" && Number.isFinite(next.enqueuedAt) && next.enqueuedAt > 0;
  if (!hasEnqueuedTimestamp) {
    return { entry: next, migrated };
  }
  return {
    entry: {
      ...next,
      lastAttemptAt: next.enqueuedAt,
    },
    migrated: true,
  };
}

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryParams & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function matchesRecoveryFilter(entry: QueuedDelivery, filter?: RecoveryFilterOptions): boolean {
  if (!filter) {
    return true;
  }
  if (filter.channel && entry.channel !== filter.channel) {
    return false;
  }
  if (filter.accountId === undefined) {
    return true;
  }
  if (entry.accountId === filter.accountId) {
    return true;
  }
  return filter.accountId === DEFAULT_ACCOUNT_ID && !entry.accountId;
}

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  filter?: RecoveryFilterOptions;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  // Rebuild index from disk on recovery (cold start)
  try {
    rebuildIndex(opts.stateDir);
  } catch {
    // Best-effort — recovery still works without index
  }
  const pending = (await loadPendingDeliveries(opts.stateDir)).filter((entry) =>
    matchesRecoveryFilter(entry, opts.filter),
  );
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
  }

  // Process oldest first.
  pending.sort((a, b) => {
    const laneDelta = lanePriorityWeight(a.lanePriority) - lanePriorityWeight(b.lanePriority);
    if (laneDelta !== 0) {
      return laneDelta;
    }
    return a.enqueuedAt - b.enqueuedAt;
  });

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline =
    Date.now() + (opts.maxRecoveryMs ?? resolveOagDeliveryRecoveryBudgetMs(opts.cfg));

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
    const maxRetries = resolveOagDeliveryMaxRetries(opts.cfg);
    if (entry.retryCount >= maxRetries) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${maxRetries}) — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
      }
      skippedMaxRetries += 1;
      continue;
    }

    const retryEligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (!retryEligibility.eligible) {
      deferredBackoff += 1;
      opts.log.info(
        `Delivery ${entry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
      );
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
        forceDocument: entry.forceDocument,
        silent: entry.silent,
        mirror: entry.mirror,
        skipQueue: true, // Prevent re-enqueueing during recovery
      });
      await ackDelivery(entry.id, opts.stateDir);
      recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPermanentDeliveryError(errMsg)) {
        opts.log.warn(`Delivery ${entry.id} hit permanent error — moving to failed/: ${errMsg}`);
        try {
          await moveToFailed(entry.id, opts.stateDir);
        } catch (moveErr) {
          opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(moveErr)}`);
        }
        failed += 1;
        continue;
      }
      try {
        await failDelivery(entry.id, errMsg, opts.stateDir);
      } catch {
        // Best-effort update.
      }
      failed += 1;
      opts.log.warn(`Retry failed for delivery ${entry.id}: ${errMsg}`);
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${recovered} recovered, ${failed} failed, ${skippedMaxRetries} skipped (max retries), ${deferredBackoff} deferred (backoff)`,
  );
  return { recovered, failed, skippedMaxRetries, deferredBackoff };
}

/** Default max retries — equivalent to calling resolveOagDeliveryMaxRetries() with no config. */
export const MAX_RETRIES = resolveOagDeliveryMaxRetries();

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous discord recipient/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
