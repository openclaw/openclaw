import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { generateSecureUuid } from "../secure-random.js";
import {
  ackDeliveryInDb,
  enqueueDeliveryToDb,
  failDeliveryInDb,
  loadDeliveryByIdFromDb,
  loadPendingDeliveriesFromDb,
  moveToFailedInDb,
} from "./delivery-queue-sqlite.js";
import type { OutboundChannel } from "./targets.js";

const MAX_RETRIES = 5;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

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
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
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

/** Persist a delivery entry to the DB before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = QueuedDeliveryPayload;

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  _stateDir?: string,
): Promise<string> {
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
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  enqueueDeliveryToDb(entry);
  return id;
}

/**
 * Remove a successfully delivered entry from the queue.
 * With SQLite this is a simple status update (retained for 7 days by retention.ts).
 */
export async function ackDelivery(id: string, _stateDir?: string): Promise<void> {
  ackDeliveryInDb(id);
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, _stateDir?: string): Promise<void> {
  // Load to get current retryCount for backoff calculation
  const entry = loadDeliveryByIdFromDb(id);
  const nextRetryCount = (entry?.retryCount ?? 0) + 1;
  const nextAttemptAt = Date.now() + computeBackoffMs(nextRetryCount);
  failDeliveryInDb(id, error, nextAttemptAt);
}

/** Load all pending delivery entries from the database. */
export async function loadPendingDeliveries(_stateDir?: string): Promise<QueuedDelivery[]> {
  return loadPendingDeliveriesFromDb();
}

/** Mark a queue entry as permanently failed. */
export async function moveToFailed(id: string, _stateDir?: string): Promise<void> {
  moveToFailedInDb(id);
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

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
  }

  // Process oldest first.
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);

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
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed: ${String(err)}`);
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
        opts.log.warn(`Delivery ${entry.id} hit permanent error — moving to failed: ${errMsg}`);
        try {
          await moveToFailed(entry.id, opts.stateDir);
        } catch (moveErr) {
          opts.log.error(`Failed to move entry ${entry.id} to failed: ${String(moveErr)}`);
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

export { MAX_RETRIES };

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
