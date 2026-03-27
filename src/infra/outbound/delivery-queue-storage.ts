import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveStateDir } from "../../config/paths.js";
import { generateSecureUuid } from "../secure-random.js";
import type { DeliveryMirror } from "./mirror.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";

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
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirror;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

type LegacyQueuedDelivery = Partial<QueuedDelivery> & {
  target?: unknown;
  attempt?: unknown;
  payload?: unknown;
  createdAt?: unknown;
};

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

async function writeQueueEntry(filePath: string, entry: QueuedDelivery): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function asRetryCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asReplyPayloads(value: unknown): ReplyPayload[] {
  if (Array.isArray(value)) {
    return value.filter(
      (payload): payload is ReplyPayload => !!payload && typeof payload === "object",
    );
  }
  return [];
}

function shouldPersistNormalizedQueuedDeliveryEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return true;
  }
  const record = raw as Record<string, unknown>;
  if ("target" in record || "attempt" in record || "payload" in record || "createdAt" in record) {
    return true;
  }
  if (!asTrimmedString(record.channel) || !asTrimmedString(record.to)) {
    return true;
  }
  if (!Array.isArray(record.payloads)) {
    return true;
  }
  if (
    typeof record.retryCount !== "number" ||
    !Number.isFinite(record.retryCount) ||
    record.retryCount < 0 ||
    Math.floor(record.retryCount) !== record.retryCount
  ) {
    return true;
  }
  if (asEpochMs(record.enqueuedAt) === null) {
    return true;
  }
  if (
    "lastAttemptAt" in record &&
    record.lastAttemptAt !== undefined &&
    asEpochMs(record.lastAttemptAt) === null
  ) {
    return true;
  }
  return false;
}

function normalizeQueuedDelivery(raw: unknown, fallbackId: string): QueuedDelivery | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as LegacyQueuedDelivery;

  const id = asTrimmedString(record.id) ?? fallbackId;
  const channel = asTrimmedString(record.channel);
  const to = asTrimmedString(record.to) ?? asTrimmedString(record.target);
  const normalizedPayloads = asReplyPayloads(record.payloads);
  const payloads =
    normalizedPayloads.length > 0
      ? normalizedPayloads
      : record.payload && typeof record.payload === "object"
        ? ([record.payload] as ReplyPayload[])
        : [];

  if (!channel || channel === "none" || !to || payloads.length === 0) {
    return null;
  }

  const mirrorRecord =
    record.mirror && typeof record.mirror === "object"
      ? (record.mirror as Partial<DeliveryMirror>)
      : null;
  const mirrorSessionKey = asTrimmedString(mirrorRecord?.sessionKey);
  const mirror =
    mirrorSessionKey !== null
      ? {
          sessionKey: mirrorSessionKey,
          agentId: asTrimmedString(mirrorRecord?.agentId) ?? undefined,
          text: typeof mirrorRecord?.text === "string" ? mirrorRecord.text : undefined,
          mediaUrls: Array.isArray(mirrorRecord?.mediaUrls)
            ? mirrorRecord.mediaUrls.filter(
                (url: unknown): url is string => typeof url === "string",
              )
            : undefined,
          idempotencyKey: asTrimmedString(mirrorRecord?.idempotencyKey) ?? undefined,
          isGroup: asBoolean(mirrorRecord?.isGroup),
          groupId: asTrimmedString(mirrorRecord?.groupId) ?? undefined,
        }
      : undefined;

  return {
    id,
    enqueuedAt: asEpochMs(record.enqueuedAt) ?? asEpochMs(record.createdAt) ?? Date.now(),
    channel: channel as Exclude<OutboundChannel, "none">,
    to,
    accountId: asTrimmedString(record.accountId) ?? undefined,
    payloads,
    threadId:
      typeof record.threadId === "string" || typeof record.threadId === "number"
        ? record.threadId
        : undefined,
    replyToId: asTrimmedString(record.replyToId) ?? undefined,
    bestEffort: asBoolean(record.bestEffort),
    gifPlayback: asBoolean(record.gifPlayback),
    forceDocument: asBoolean(record.forceDocument),
    silent: asBoolean(record.silent),
    mirror,
    retryCount: asRetryCount(record.retryCount ?? record.attempt),
    lastAttemptAt: asEpochMs(record.lastAttemptAt) ?? undefined,
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
  };
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
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
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
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
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
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const normalized = normalizeQueuedDelivery(JSON.parse(raw), id);
  if (!normalized) {
    throw new Error(`Invalid queued delivery entry: ${id}`);
  }
  const entry = normalized;
  entry.retryCount = asRetryCount(entry.retryCount) + 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  await writeQueueEntry(filePath, entry);
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
    if (file.endsWith(".delivered")) {
      await unlinkBestEffort(path.join(queueDir, file));
    }
  }

  const entries: QueuedDelivery[] = [];
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
      const parsedRaw = JSON.parse(raw);
      const parsed = normalizeQueuedDelivery(parsedRaw, file.slice(0, -".json".length));
      if (!parsed) {
        continue;
      }
      const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(parsed);
      if (migrated || shouldPersistNormalizedQueuedDeliveryEntry(parsedRaw)) {
        await writeQueueEntry(filePath, entry);
      }
      entries.push(entry);
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
