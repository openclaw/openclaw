import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { getLifecycleDb, runLifecycleTransaction } from "../message-lifecycle/db.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundChannel } from "./targets.js";

const MAX_RETRIES = 5;
export { MAX_RETRIES };

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

/** Default expiry for stale queued messages. */
const DEFAULT_OUTBOX_MAX_AGE_MS = 30 * 60_000;
/** Terminal outbox rows older than this are pruned. */
export const OUTBOX_PRUNE_AGE_MS = 48 * 60 * 60_000;

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
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
  /** Dispatch kind (tool/block/final). Non-final entries are skipped during recovery. */
  dispatchKind?: "tool" | "block" | "final";
};

type QueuedDeliveryParams = QueuedDeliveryPayload & {
  turnId?: string;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  turnId?: string;
  dispatchKind?: "tool" | "block" | "final";
}

export type RecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
  /** Entries skipped because they were enqueued after gateway startup (live delivery in progress). */
  skippedStartupCutoff: number;
};

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

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, "delivery-queue");
}

function resolveDeliveryMaxAgeMs(cfg: OpenClawConfig): number {
  const configured = cfg.messages?.delivery?.maxAgeMs;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_OUTBOX_MAX_AGE_MS;
  }
  return Math.floor(configured);
}

function resolveExpireAction(cfg: OpenClawConfig): "fail" | "deliver" {
  const action = cfg.messages?.delivery?.expireAction;
  return action === "deliver" ? "deliver" : "fail";
}

export async function ensureQueueDir(stateDir?: string): Promise<string> {
  // Kept for backward compatibility with callers/tests that expect this helper.
  // SQLite-backed queue does not require directory structure, but we retain the
  // legacy queue path for one-time import support.
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.join(queueDir, "failed"), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const db = getLifecycleDb(stateDir);
  const id = generateSecureUuid();
  const now = Date.now();
  const payload = JSON.stringify({
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
    dispatchKind: params.dispatchKind,
  });
  db.prepare(
    `INSERT INTO message_outbox
       (id, turn_id, channel, account_id, target, payload, queued_at, status, attempt_count, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
  ).run(
    id,
    params.turnId ?? null,
    params.channel,
    params.accountId ?? "",
    params.to,
    payload,
    now,
    now,
  );
  return id;
}

/** Mark a delivery as successful. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const db = getLifecycleDb(stateDir);
  try {
    db.prepare(
      `UPDATE message_outbox
         SET status='delivered', delivered_at=?, completed_at=?
       WHERE id=?`,
    ).run(Date.now(), Date.now(), id);
  } catch (err) {
    logVerbose(`delivery-queue: ackDelivery failed: ${String(err)}`);
  }
}

/** Record a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const db = getLifecycleDb(stateDir);
  try {
    const row = db.prepare(`SELECT attempt_count FROM message_outbox WHERE id=?`).get(id) as
      | { attempt_count: number }
      | undefined;
    if (!row) {
      return;
    }
    const now = Date.now();
    if (isPermanentDeliveryError(error)) {
      db.prepare(
        `UPDATE message_outbox
           SET status='failed_terminal',
               error_class='permanent',
               last_error=?,
               completed_at=?,
               terminal_reason=?
         WHERE id=?`,
      ).run(error, now, error, id);
      return;
    }
    const nextCount = row.attempt_count + 1;
    if (nextCount >= MAX_RETRIES) {
      db.prepare(
        `UPDATE message_outbox
           SET status='failed_terminal',
               error_class='terminal',
               attempt_count=?,
               last_error=?,
               last_attempt_at=?,
               completed_at=?,
               terminal_reason=?
         WHERE id=?`,
      ).run(nextCount, error, now, now, error, id);
      return;
    }
    db.prepare(
      `UPDATE message_outbox
         SET status='failed_retryable',
             attempt_count=?,
             last_error=?,
             last_attempt_at=?,
             next_attempt_at=?
       WHERE id=?`,
    ).run(nextCount, error, now, now + computeBackoffMs(nextCount), id);
  } catch (err) {
    logVerbose(`delivery-queue: failDelivery failed: ${String(err)}`);
  }
}

/** Load pending queue entries eligible for retry now. */
export async function loadPendingDeliveries(
  stateDir?: string,
  startupCutoff?: number,
): Promise<QueuedDelivery[]> {
  const db = getLifecycleDb(stateDir);
  try {
    // When a startupCutoff is supplied (gateway startup timestamp), exclude entries that were
    // enqueued during this instance's lifetime and have never been attempted. Those entries are
    // actively being delivered on the direct path; picking them up would cause duplicate sends.
    // Entries enqueued before startup (crash survivors) or entries that have already had at least
    // one attempt (transient failures) are always included.
    const now = Date.now();
    const rows = (
      startupCutoff !== undefined
        ? db
            .prepare(
              `SELECT id, payload, queued_at, attempt_count, last_attempt_at, last_error, turn_id
                 FROM message_outbox
                WHERE status IN ('queued', 'failed_retryable')
                  AND next_attempt_at <= ?
                  AND (queued_at < ? OR last_attempt_at IS NOT NULL OR attempt_count > 0)
                ORDER BY queued_at ASC`,
            )
            .all(now, startupCutoff)
        : db
            .prepare(
              `SELECT id, payload, queued_at, attempt_count, last_attempt_at, last_error, turn_id
                 FROM message_outbox
                WHERE status IN ('queued', 'failed_retryable')
                  AND next_attempt_at <= ?
                ORDER BY queued_at ASC`,
            )
            .all(now)
    ) as Array<{
      id: string;
      payload: string;
      queued_at: number;
      attempt_count: number;
      last_attempt_at: number | null;
      last_error: string | null;
      turn_id: string | null;
    }>;

    const entries: QueuedDelivery[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as QueuedDeliveryPayload;
        entries.push({
          ...parsed,
          id: row.id,
          enqueuedAt: row.queued_at,
          retryCount: row.attempt_count,
          ...(row.last_attempt_at != null ? { lastAttemptAt: row.last_attempt_at } : {}),
          ...(row.last_error ? { lastError: row.last_error } : {}),
          ...(row.turn_id ? { turnId: row.turn_id } : {}),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        db.prepare(
          `UPDATE message_outbox
             SET status='failed_terminal',
                 error_class='terminal',
                 last_error=?,
                 terminal_reason=?,
                 completed_at=?
           WHERE id=?`,
        ).run(`invalid payload: ${errMsg}`, `invalid payload: ${errMsg}`, Date.now(), row.id);
      }
    }
    return entries;
  } catch (err) {
    logVerbose(`delivery-queue: loadPendingDeliveries failed: ${String(err)}`);
    return [];
  }
}

/** Mark an entry as terminal failed. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const db = getLifecycleDb(stateDir);
  try {
    db.prepare(
      `UPDATE message_outbox
         SET status='failed_terminal',
             error_class='terminal',
             terminal_reason=COALESCE(terminal_reason,'moved to failed'),
             completed_at=?
       WHERE id=?`,
    ).run(Date.now(), id);
  } catch (err) {
    logVerbose(`delivery-queue: moveToFailed failed: ${String(err)}`);
  }
}

/** Compute retry backoff in milliseconds. */
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
  // Use the same backoff level that failDelivery used when writing next_attempt_at.
  // failDelivery increments attempt_count to nextCount and writes
  // next_attempt_at = now + computeBackoffMs(nextCount), so entry.retryCount
  // already reflects the incremented value.
  const backoff = computeBackoffMs(entry.retryCount);
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
  const baseAttemptAt = hasAttemptTimestamp ? entry.lastAttemptAt! : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

/**
 * Import legacy file queue entries into SQLite outbox.
 * This is deterministic and idempotent for existing IDs.
 */
export async function importLegacyFileQueue(stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const db = getLifecycleDb(stateDir);
  let files: string[];
  try {
    files = fs.readdirSync(queueDir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(raw) as QueuedDelivery;
      if (!entry.id || !entry.channel || !entry.to) {
        continue;
      }
      const payload = JSON.stringify({
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
      });
      runLifecycleTransaction(db, () => {
        db.prepare(
          `INSERT OR IGNORE INTO message_outbox
             (id, turn_id, channel, account_id, target, payload, queued_at, status,
              attempt_count, next_attempt_at, last_error, last_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          entry.turnId ?? null,
          entry.channel,
          entry.accountId ?? "",
          entry.to,
          payload,
          entry.enqueuedAt ?? Date.now(),
          "queued",
          entry.retryCount ?? 0,
          entry.lastAttemptAt ?? entry.enqueuedAt ?? Date.now(),
          entry.lastError ?? null,
          entry.lastAttemptAt ?? null,
        );
      });
      fs.unlinkSync(filePath);
    } catch (err) {
      logVerbose(`delivery-queue: failed to import ${filePath}: ${String(err)}`);
    }
  }
}

/**
 * Retry pending queue entries.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  maxRecoveryMs?: number;
  /** Timestamp of this gateway instance's startup. Entries enqueued after this time with no
   *  prior attempt are skipped — they are actively being delivered on the direct path. */
  startupCutoff?: number;
}): Promise<RecoverySummary> {
  if (resolveExpireAction(opts.cfg) === "fail") {
    const db = getLifecycleDb(opts.stateDir);
    const staleCutoff = Date.now() - resolveDeliveryMaxAgeMs(opts.cfg);
    try {
      db.prepare(
        `UPDATE message_outbox
           SET status='expired',
               error_class='terminal',
               last_error='expired: queued_at too old',
               terminal_reason='expired',
               completed_at=?
         WHERE status IN ('queued','failed_retryable')
           AND queued_at < ?`,
      ).run(Date.now(), staleCutoff);
    } catch (err) {
      logVerbose(`delivery-queue: expiry update failed: ${String(err)}`);
    }
  }

  const pending = await loadPendingDeliveries(opts.stateDir, opts.startupCutoff);

  // Count entries excluded by the startup cutoff so the log reflects full activity.
  let skippedStartupCutoff = 0;
  if (opts.startupCutoff !== undefined) {
    const db = getLifecycleDb(opts.stateDir);
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM message_outbox
            WHERE status IN ('queued','failed_retryable')
              AND next_attempt_at <= ?
              AND queued_at >= ?
              AND last_attempt_at IS NULL
              AND attempt_count = 0`,
        )
        .get(Date.now(), opts.startupCutoff) as { cnt: number } | undefined;
      skippedStartupCutoff = row?.cnt ?? 0;
    } catch {
      // non-fatal
    }
  }

  // Non-final payloads (tool results, blocks) are expendable during crash recovery —
  // the turn recovery worker replays the entire turn, regenerating them. Recovering them
  // would send them as separate messages through deliverOutboundPayloads, bypassing
  // channel-specific kind filtering (e.g. web channel suppresses non-final sends).
  const db2 = getLifecycleDb(opts.stateDir);
  const finalOnly: QueuedDelivery[] = [];
  for (const entry of pending) {
    if (entry.dispatchKind && entry.dispatchKind !== "final") {
      try {
        db2
          .prepare(
            `UPDATE message_outbox
             SET status='failed_terminal',
                 error_class='terminal',
                 terminal_reason='non_final_recovery_skip',
                 completed_at=?
           WHERE id=?`,
          )
          .run(Date.now(), entry.id);
      } catch {
        // non-fatal
      }
      continue;
    }
    finalOnly.push(entry);
  }

  if (finalOnly.length === 0) {
    return {
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
      skippedStartupCutoff,
    };
  }
  opts.log.info(`Found ${finalOnly.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  let recovered = 0;
  let failed = 0;
  let skippedMaxRetries = 0;
  let deferredBackoff = 0;

  for (const entry of finalOnly) {
    const now = Date.now();
    if (now >= deadline) {
      const deferred = finalOnly.length - recovered - failed - skippedMaxRetries - deferredBackoff;
      opts.log.warn(`Recovery time budget exceeded — ${deferred} entries deferred to next tick`);
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      await moveToFailed(entry.id, opts.stateDir);
      skippedMaxRetries += 1;
      continue;
    }
    const eligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (!eligibility.eligible) {
      deferredBackoff += 1;
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
        turnId: entry.turnId,
        skipQueue: true,
      });
      // Delivery succeeded — ack failure is bookkeeping, not a delivery failure.
      // Don't let a transient SQLITE_BUSY on ack cause failDelivery on a sent message.
      try {
        await ackDelivery(entry.id, opts.stateDir);
      } catch (ackErr) {
        opts.log.warn(`delivery ${entry.id}: ack failed after successful send: ${String(ackErr)}`);
      }
      recovered += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanentDeliveryError(message)) {
        await moveToFailed(entry.id, opts.stateDir);
      } else {
        await failDelivery(entry.id, message, opts.stateDir);
      }
      failed += 1;
    }
  }

  return { recovered, failed, skippedMaxRetries, deferredBackoff, skippedStartupCutoff };
}

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

export function pruneOutbox(ageMs: number, stateDir?: string): void {
  const db = getLifecycleDb(stateDir);
  const cutoff = Date.now() - ageMs;
  try {
    db.prepare(
      `DELETE FROM message_outbox
        WHERE status IN ('delivered','failed_terminal','expired')
          AND COALESCE(completed_at, delivered_at, queued_at) < ?`,
    ).run(cutoff);
  } catch (err) {
    logVerbose(`delivery-queue: pruneOutbox failed: ${String(err)}`);
  }
}
