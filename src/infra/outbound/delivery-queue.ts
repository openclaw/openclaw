import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const MAX_RETRIES = 5;
const DEFAULT_RECOVERY_DELIVERY_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_ENTRY_TTL_MS = 24 * 60 * 60_000;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeQueuedDeliveryForRecovery(
  value: unknown,
  fallbackId: string,
): QueuedDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = trimNonEmptyString(raw.id) ?? fallbackId;
  const channel = trimNonEmptyString(raw.channel);
  const to = trimNonEmptyString(raw.to);
  const payloads = raw.payloads;
  const enqueuedAt = raw.enqueuedAt;
  const retryCount = raw.retryCount;
  if (!channel || channel === "none" || !to || !Array.isArray(payloads)) {
    return null;
  }
  if (typeof enqueuedAt !== "number" || !Number.isFinite(enqueuedAt)) {
    return null;
  }
  if (typeof retryCount !== "number" || !Number.isFinite(retryCount) || retryCount < 0) {
    return null;
  }
  const mirrorRaw = raw.mirror;
  const mirror =
    mirrorRaw && typeof mirrorRaw === "object" && !Array.isArray(mirrorRaw)
      ? {
          sessionKey: trimNonEmptyString((mirrorRaw as { sessionKey?: unknown }).sessionKey) ?? "",
          agentId: trimNonEmptyString((mirrorRaw as { agentId?: unknown }).agentId),
          text:
            typeof (mirrorRaw as { text?: unknown }).text === "string"
              ? (mirrorRaw as { text?: string }).text
              : undefined,
          mediaUrls: Array.isArray((mirrorRaw as { mediaUrls?: unknown }).mediaUrls)
            ? ((mirrorRaw as { mediaUrls?: unknown[] }).mediaUrls as string[]).filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined;
  return {
    id,
    enqueuedAt,
    channel: channel as Exclude<OutboundChannel, "none">,
    to,
    accountId: trimNonEmptyString(raw.accountId),
    payloads: payloads as ReplyPayload[],
    threadId:
      raw.threadId == null || typeof raw.threadId === "string" || typeof raw.threadId === "number"
        ? raw.threadId
        : undefined,
    replyToId:
      raw.replyToId == null || typeof raw.replyToId === "string" ? raw.replyToId : undefined,
    bestEffort: typeof raw.bestEffort === "boolean" ? raw.bestEffort : undefined,
    gifPlayback: typeof raw.gifPlayback === "boolean" ? raw.gifPlayback : undefined,
    silent: typeof raw.silent === "boolean" ? raw.silent : undefined,
    mirror: mirror?.sessionKey ? mirror : undefined,
    retryCount: Math.floor(retryCount),
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
  };
}

function shouldExpireEntry(params: { enqueuedAt: number; now: number; ttlMs: number }): boolean {
  if (params.ttlMs <= 0) {
    return false;
  }
  return params.now - params.enqueuedAt >= params.ttlMs;
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return await promise;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`delivery recovery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

export interface QueuedDelivery {
  id: string;
  enqueuedAt: number;
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
  retryCount: number;
  lastError?: string;
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = {
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
};

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = crypto.randomUUID();
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
  const filePath = path.join(queueDir, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(entry, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code !== "ENOENT") {
      throw err;
    }
    // Already removed — no-op.
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
  entry.retryCount += 1;
  entry.lastError = error;
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
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const fileId = file.slice(0, -".json".length);
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const normalized = normalizeQueuedDeliveryForRecovery(JSON.parse(raw), fileId);
      if (!normalized) {
        await moveToFailed(fileId, stateDir).catch(() => {});
        continue;
      }
      entries.push(normalized);
    } catch {
      // Malformed queue entries are quarantined so recovery doesn't loop forever.
      await moveToFailed(fileId, stateDir).catch(() => {});
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const src = path.join(queueDir, `${id}.json`);
  const dest = path.join(failedDir, `${id}.json`);
  await fs.promises.rename(src, dest);
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
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
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Override for testing — resolves instead of using real setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
  /** Maximum age for queue entries before forcing permanent failure. Default: 24h. */
  entryTtlMs?: number;
  /** Timeout per delivery attempt while recovering. Default: 15 000ms. */
  deliveryTimeoutMs?: number;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }

  // Process oldest first.
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const delayFn = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  const entryTtlMs = opts.entryTtlMs ?? DEFAULT_RECOVERY_ENTRY_TTL_MS;
  const deliveryTimeoutMs = opts.deliveryTimeoutMs ?? DEFAULT_RECOVERY_DELIVERY_TIMEOUT_MS;

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    const now = Date.now();
    if (now >= deadline) {
      const deferred = pending.length - index;
      opts.log.warn(`Recovery time budget exceeded — ${deferred} entries deferred to next restart`);
      break;
    }
    if (shouldExpireEntry({ enqueuedAt: entry.enqueuedAt, now, ttlMs: entryTtlMs })) {
      opts.log.warn(
        `Delivery ${entry.id} expired after ${Math.max(now - entry.enqueuedAt, 0)}ms in queue — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move expired entry ${entry.id} to failed/: ${String(err)}`);
      }
      skipped += 1;
      continue;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
      }
      skipped += 1;
      continue;
    }

    const backoff = computeBackoffMs(entry.retryCount + 1);
    if (backoff > 0) {
      const remainingBudgetMs = Math.max(deadline - now, 0);
      if (backoff >= remainingBudgetMs) {
        const reason = `recovery budget too small for backoff (${backoff}ms > ${remainingBudgetMs}ms)`;
        entry.retryCount += 1;
        entry.lastError = reason;
        try {
          await failDelivery(entry.id, reason, opts.stateDir);
        } catch (err) {
          opts.log.error(`Failed to record deferred retry for ${entry.id}: ${String(err)}`);
        }
        let movedToFailed = false;
        if (entry.retryCount >= MAX_RETRIES) {
          try {
            await moveToFailed(entry.id, opts.stateDir);
            movedToFailed = true;
            skipped += 1;
          } catch (err) {
            opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
          }
        }
        if (!movedToFailed) {
          failed += 1;
        }
        opts.log.warn(
          `Deferring retry for delivery ${entry.id}: ${reason} (attempt ${entry.retryCount}/${MAX_RETRIES})`,
        );
        break;
      }
      opts.log.info(`Waiting ${backoff}ms before retrying delivery ${entry.id}`);
      await delayFn(backoff);
      if (Date.now() >= deadline) {
        const deferred = pending.length - (index + 1);
        opts.log.warn(
          `Recovery time budget exceeded — ${deferred} entries deferred to next restart`,
        );
        break;
      }
    }

    try {
      const remainingBudgetMs = Math.max(deadline - Date.now(), 0);
      if (remainingBudgetMs <= 0) {
        const deferred = pending.length - (index + 1);
        opts.log.warn(
          `Recovery time budget exceeded — ${deferred} entries deferred to next restart`,
        );
        break;
      }
      const attemptTimeoutMs = Math.max(1_000, Math.min(deliveryTimeoutMs, remainingBudgetMs));
      await runWithTimeout(
        opts.deliver({
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
        }),
        attemptTimeoutMs,
      );
      await ackDelivery(entry.id, opts.stateDir);
      recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.retryCount += 1;
      entry.lastError = message;
      try {
        await failDelivery(entry.id, message, opts.stateDir);
      } catch (updateErr) {
        opts.log.error(`Failed to update retry metadata for ${entry.id}: ${String(updateErr)}`);
      }
      let movedToFailed = false;
      opts.log.warn(`Retry failed for delivery ${entry.id}: ${message}`);
      if (entry.retryCount >= MAX_RETRIES) {
        try {
          await moveToFailed(entry.id, opts.stateDir);
          movedToFailed = true;
          skipped += 1;
        } catch (moveErr) {
          opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(moveErr)}`);
        }
      }
      if (!movedToFailed) {
        failed += 1;
      }
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${recovered} recovered, ${failed} failed, ${skipped} skipped (expired/max retries)`,
  );
  return { recovered, failed, skipped };
}

export { MAX_RETRIES };
