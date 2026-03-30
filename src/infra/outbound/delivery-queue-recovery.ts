import type { OpenClawConfig } from "../../config/config.js";
import {
  ackDelivery,
  failDelivery,
  loadPendingDeliveries,
  moveToFailed,
  type QueuedDelivery,
  type QueuedDeliveryPayload,
} from "./delivery-queue-storage.js";

export type RecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryPayload & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const MAX_RETRIES = 5;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous discord recipient/i,
  /User .* not in room/i,
  /message is too long/i,
];

function createEmptyRecoverySummary(): RecoverySummary {
  return {
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  };
}

function buildRecoveryDeliverParams(entry: QueuedDelivery, cfg: OpenClawConfig) {
  return {
    cfg,
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
    gatewayClientScopes: entry.gatewayClientScopes,
    skipQueue: true, // Prevent re-enqueueing during recovery.
  } satisfies Parameters<DeliverFn>[0];
}

async function moveEntryToFailedWithLogging(
  entryId: string,
  log: RecoveryLogger,
  stateDir?: string,
): Promise<void> {
  try {
    await moveToFailed(entryId, stateDir);
  } catch (err) {
    log.error(`Failed to move entry ${entryId} to failed/: ${String(err)}`);
  }
}

async function deferRemainingEntriesForBudget(
  entries: readonly QueuedDelivery[],
  stateDir: string | undefined,
): Promise<void> {
  // Increment retryCount so entries that are repeatedly deferred by the
  // recovery budget eventually hit MAX_RETRIES and get pruned.
  await Promise.allSettled(
    entries.map((entry) => failDelivery(entry.id, "recovery time budget exceeded", stateDir)),
  );
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

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
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
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return createEmptyRecoverySummary();
  }

  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  const summary = createEmptyRecoverySummary();

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const now = Date.now();
    if (now >= deadline) {
      opts.log.warn(`Recovery time budget exceeded — remaining entries deferred to next startup`);
      await deferRemainingEntriesForBudget(pending.slice(i), opts.stateDir);
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
      );
      await moveEntryToFailedWithLogging(entry.id, opts.log, opts.stateDir);
      summary.skippedMaxRetries += 1;
      continue;
    }

    const retryEligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (!retryEligibility.eligible) {
      summary.deferredBackoff += 1;
      opts.log.info(
        `Delivery ${entry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
      );
      continue;
    }

    try {
      await opts.deliver(buildRecoveryDeliverParams(entry, opts.cfg));
      await ackDelivery(entry.id, opts.stateDir);
      summary.recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPermanentDeliveryError(errMsg)) {
        opts.log.warn(`Delivery ${entry.id} hit permanent error — moving to failed/: ${errMsg}`);
        await moveEntryToFailedWithLogging(entry.id, opts.log, opts.stateDir);
        summary.failed += 1;
        continue;
      }
      try {
        await failDelivery(entry.id, errMsg, opts.stateDir);
      } catch {
        // Best-effort update.
      }
      summary.failed += 1;
      opts.log.warn(`Retry failed for delivery ${entry.id}: ${errMsg}`);
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`,
  );
  return summary;
}

export { MAX_RETRIES };
