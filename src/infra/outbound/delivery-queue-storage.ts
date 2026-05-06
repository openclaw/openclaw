import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ReplyToMode } from "../../config/types.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const QUEUE_TEMP_PREFIX = ".delivery-queue";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  recoveryState?: "send_attempt_started" | "unknown_after_send";
}

export function resolveQueueDir(stateDir?: string): string {
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
  return resolveJsonDurableQueueEntryPaths(resolveQueueDir(stateDir), id);
}

function resolveJsonDurableQueueEntryPaths(queueDir: string, id: string) {
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

async function writeJsonDurableQueueEntry<T>(params: {
  filePath: string;
  entry: T;
  tempPrefix: string;
}): Promise<void> {
  const tempPath = path.join(
    path.dirname(params.filePath),
    `${params.tempPrefix}-${path.basename(params.filePath)}`,
  );
  await fs.promises.writeFile(tempPath, JSON.stringify(params.entry, null, 2), "utf8");
  await fs.promises.rename(tempPath, params.filePath);
}

async function readJsonDurableQueueEntry<T>(filePath: string): Promise<T> {
  const data = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(data) as T;
}

async function ensureJsonDurableQueueDirs(params: {
  queueDir: string;
  failedDir: string;
}): Promise<void> {
  await fs.promises.mkdir(params.queueDir, { recursive: true });
  await fs.promises.mkdir(params.failedDir, { recursive: true });
}

async function ackJsonDurableQueueEntry(paths: {
  jsonPath: string;
  deliveredPath: string;
}): Promise<void> {
  try {
    await fs.promises.rename(paths.jsonPath, paths.deliveredPath);
    await fs.promises.unlink(paths.deliveredPath);
  } catch (err: any) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

async function loadJsonDurableQueueEntry<T>(params: {
  paths: { jsonPath: string; deliveredPath: string };
  tempPrefix: string;
  read: (entry: any) => Promise<{ entry: T; migrated: boolean }>;
}): Promise<T | null> {
  try {
    const deliveredStat = await fs.promises.stat(params.paths.deliveredPath).catch(() => null);
    if (deliveredStat) {
      await fs.promises.unlink(params.paths.deliveredPath).catch(() => {});
      return null;
    }
    const data = await readJsonDurableQueueEntry<any>(params.paths.jsonPath);
    const { entry, migrated } = await params.read(data);
    if (migrated) {
      await writeJsonDurableQueueEntry({
        filePath: params.paths.jsonPath,
        entry,
        tempPrefix: params.tempPrefix,
      });
    }
    return entry;
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function loadPendingJsonDurableQueueEntries<T>(params: {
  queueDir: string;
  tempPrefix: string;
  read: (entry: any) => Promise<{ entry: T; migrated: boolean }>;
}): Promise<T[]> {
  const entries: T[] = [];
  let files: string[];
  try {
    files = await fs.promises.readdir(params.queueDir);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  for (const file of files) {
    if (file.startsWith(params.tempPrefix)) {
      await fs.promises.unlink(path.join(params.queueDir, file)).catch(() => {});
      continue;
    }
    if (file.endsWith(".delivered")) {
      await fs.promises.unlink(path.join(params.queueDir, file)).catch(() => {});
      continue;
    }
    if (!file.endsWith(".json")) continue;

    const id = path.basename(file, ".json");
    const paths = resolveJsonDurableQueueEntryPaths(params.queueDir, id);
    const entry = await loadJsonDurableQueueEntry({
      paths,
      tempPrefix: params.tempPrefix,
      read: params.read,
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

async function moveJsonDurableQueueEntryToFailed(params: {
  queueDir: string;
  failedDir: string;
  id: string;
}) {
  const source = path.join(params.queueDir, `${params.id}.json`);
  const dest = path.join(params.failedDir, `${params.id}.json`);
  try {
    await fs.promises.rename(source, dest);
  } catch (err: any) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

async function writeQueueEntry(filePath: string, entry: QueuedDelivery): Promise<void> {
  await writeJsonDurableQueueEntry({
    filePath,
    entry,
    tempPrefix: QUEUE_TEMP_PREFIX,
  });
}

async function readQueueEntry(filePath: string): Promise<QueuedDelivery> {
  return await readJsonDurableQueueEntry<QueuedDelivery>(filePath);
}

function normalizeLegacyQueuedDeliveryEntry(entry: QueuedDelivery): {
  entry: QueuedDelivery;
  migrated: boolean;
} {
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  if (hasAttemptTimestamp || entry.retryCount <= 0) {
    return { entry, migrated: false };
  }
  const hasEnqueuedTimestamp =
    typeof entry.enqueuedAt === "number" &&
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
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await ensureJsonDurableQueueDirs({
    queueDir,
    failedDir: resolveFailedDir(stateDir),
  });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = generateSecureUuid();
  await writeQueueEntry(path.join(queueDir, `${id}.json`), {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
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
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  await ackJsonDurableQueueEntry(resolveQueueEntryPaths(id, stateDir));
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  await writeQueueEntry(filePath, entry);
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "send_attempt_started";
  await writeQueueEntry(filePath, entry);
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "unknown_after_send";
  await writeQueueEntry(filePath, entry);
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return await loadJsonDurableQueueEntry({
    paths: resolveQueueEntryPaths(id, stateDir),
    tempPrefix: QUEUE_TEMP_PREFIX,
    read: async (entry) => normalizeLegacyQueuedDeliveryEntry(entry),
  });
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  return await loadPendingJsonDurableQueueEntries({
    queueDir,
    tempPrefix: QUEUE_TEMP_PREFIX,
    read: async (entry) => normalizeLegacyQueuedDeliveryEntry(entry),
  });
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  await moveJsonDurableQueueEntryToFailed({
    queueDir: resolveQueueDir(stateDir),
    failedDir: resolveFailedDir(stateDir),
    id,
  });
}
