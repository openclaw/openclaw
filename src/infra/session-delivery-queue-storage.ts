import { createHash } from "node:crypto";
import path from "node:path";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  jsonDurableQueueEntryExists,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  readJsonDurableQueueEntry,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "@openclaw/fs-safe/store";
import type { ChatType } from "../channels/chat-type.js";
import { resolveStateDir } from "../config/paths.js";
import { generateSecureUuid } from "./secure-random.js";

const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5_000;
const QUEUE_TEMP_PREFIX = ".session-delivery-queue";

type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionDeliveryRetryPolicy = {
  maxRetries?: number;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export type QueuedSessionDeliveryPayload =
  | ({
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy)
  | ({
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      expectedSessionId?: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy);

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  /**
   * Wall-clock time the platform send was first attempted, mirroring the
   * outbound queue's QueuedDelivery.platformSendStartedAt. Set together with
   * {@link recoveryState} so recovery can refuse a blind replay of an entry
   * whose first attempt may already have run a turn / sent a reply.
   */
  platformSendStartedAt?: number;
  /**
   * Recovery reconciliation marker, mirroring the outbound queue. When set, the
   * entry was past the point where the delivery (turn re-run + platform send)
   * had begun but had not been acked, so a blind replay could double-execute a
   * non-idempotent turn. Recovery refuses to replay such entries.
   */
  recoveryState?: "send_attempt_started" | "unknown_after_send";
};

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

async function writeQueueEntry(filePath: string, entry: QueuedSessionDelivery): Promise<void> {
  await writeJsonDurableQueueEntry({
    filePath,
    entry,
    tempPrefix: QUEUE_TEMP_PREFIX,
  });
}

async function readQueueEntry(filePath: string): Promise<QueuedSessionDelivery> {
  return await readJsonDurableQueueEntry<QueuedSessionDelivery>(filePath);
}

export function resolveSessionDeliveryQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}

function resolveQueueEntryPaths(
  id: string,
  stateDir?: string,
): {
  jsonPath: string;
  deliveredPath: string;
} {
  return resolveJsonDurableQueueEntryPaths(resolveSessionDeliveryQueueDir(stateDir), id);
}

async function ensureSessionDeliveryQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  await ensureJsonDurableQueueDirs({
    queueDir,
    failedDir: resolveFailedDir(stateDir),
  });
  return queueDir;
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
  const id = buildEntryId(params.idempotencyKey);
  const filePath = path.join(queueDir, `${id}.json`);

  if (params.idempotencyKey) {
    if (await jsonDurableQueueEntryExists(filePath)) {
      return id;
    }
  }

  await writeQueueEntry(filePath, {
    ...params,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  });
  return id;
}

export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  await ackJsonDurableQueueEntry(resolveQueueEntryPaths(id, stateDir));
}

export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  await writeQueueEntry(filePath, entry);
}

/**
 * Persist the `send_attempt_started` recovery marker before the platform send
 * begins. Mirrors markDeliveryPlatformSendAttemptStarted in the outbound queue:
 * once this is durable, a crash before ack leaves evidence that the send may
 * already have happened, so recovery refuses to blindly replay it.
 */
export async function markSessionDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "send_attempt_started";
  await writeQueueEntry(filePath, entry);
}

/**
 * Persist the `unknown_after_send` recovery marker after the platform send has
 * returned but before the entry is acked. Mirrors
 * markDeliveryPlatformOutcomeUnknown in the outbound queue.
 */
export async function markSessionDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "unknown_after_send";
  await writeQueueEntry(filePath, entry);
}

/**
 * Clear the recovery marker. Used when a recovery attempt concluded in-process
 * with a thrown failure (as opposed to a crash): the attempt is over and
 * replayable, so the send marker set before the attempt must not survive and
 * cause the next recovery to refuse a blind replay.
 */
export async function clearSessionDeliveryRecoveryState(
  id: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  if (entry.recoveryState === undefined && entry.platformSendStartedAt === undefined) {
    return;
  }
  delete entry.recoveryState;
  delete entry.platformSendStartedAt;
  await writeQueueEntry(filePath, entry);
}

export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  return await loadJsonDurableQueueEntry({
    paths: resolveQueueEntryPaths(id, stateDir),
    tempPrefix: QUEUE_TEMP_PREFIX,
  });
}

export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  return await loadPendingJsonDurableQueueEntries({
    queueDir: resolveSessionDeliveryQueueDir(stateDir),
    tempPrefix: QUEUE_TEMP_PREFIX,
    cleanupTmpMaxAgeMs: TMP_SWEEP_MAX_AGE_MS,
  });
}

export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  await moveJsonDurableQueueEntryToFailed({
    queueDir: resolveSessionDeliveryQueueDir(stateDir),
    failedDir: resolveFailedDir(stateDir),
    id,
  });
}
