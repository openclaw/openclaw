import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatType } from "../channels/chat-type.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import { generateSecureUuid } from "./secure-random.js";

const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5_000;

export const DEFAULT_FAILED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_QUEUE_DIR_MAX_FILES = 10_000;

export class SessionDeliveryQueueOverflowError extends Error {
  readonly kind = "session-delivery-queue-overflow" as const;
  readonly count: number;
  readonly maxFiles: number;
  constructor(count: number, maxFiles: number) {
    super(
      `session-delivery-queue overflow: ${count} queued files at top level, soft-cap is ${maxFiles}`,
    );
    this.name = "SessionDeliveryQueueOverflowError";
    this.count = count;
    this.maxFiles = maxFiles;
  }
}

export type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export interface AttachmentRef {
  kind: "blob-sha256";
  sha256: string;
  mediaType?: string;
}

type QueuedSessionDeliveryPayloadMetadata = {
  /**
   * W3C trace-context traceparent for chain-correlation runtime. This is the
   * address-recipient shape; broadcast-mode surfaces use the same substrate
   * with a different verb set.
   */
  traceparent?: string;
  /**
   * Descriptor-stub attachment references for sibling enrichment runtime.
   * This is the address-recipient shape; broadcast mode uses the same substrate
   * with a different verb set.
   */
  attachments?: AttachmentRef[];
};

export type QueuedSessionDeliveryPayload = (
  | {
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
  | {
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
  | {
      kind: "postCompactionDelegate";
      sessionKey: string;
      task: string;
      createdAt: number;
      firstArmedAt?: number;
      silent?: boolean;
      silentWake?: boolean;
      targetSessionKey?: string;
      targetSessionKeys?: string[];
      fanoutMode?: "tree" | "all";
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
) &
  QueuedSessionDeliveryPayloadMetadata;

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
};

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

// Strip trailing whitespace per line and at end-of-string before hashing the
// idempotency key, so same-intent keys that differ only by trailing whitespace
// produce the same sha256 taskHash and the replay-dedupe path stays robust.
function canonicalizeIdempotencyKey(key: string): string {
  return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return createHash("sha256").update(canonicalizeIdempotencyKey(idempotencyKey)).digest("hex");
}

function buildPostCompactionDelegateIdempotencyKey(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
}): string {
  const taskHash = createHash("sha256").update(params.delegate.task).digest("hex").slice(0, 16);
  return [
    "post-compaction-delegate",
    params.sessionKey,
    String(params.compactionCount ?? "unknown"),
    String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
    String(params.sequence),
    taskHash,
  ].join(":");
}

export function buildPostCompactionDelegateDeliveryPayload(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  return {
    kind: "postCompactionDelegate",
    sessionKey: params.sessionKey,
    task: params.delegate.task,
    createdAt: params.delegate.createdAt,
    firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
    ...(params.delegate.silent != null ? { silent: params.delegate.silent } : {}),
    ...(params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {}),
    ...(params.delegate.targetSessionKey
      ? { targetSessionKey: params.delegate.targetSessionKey }
      : {}),
    ...(params.delegate.targetSessionKeys && params.delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: params.delegate.targetSessionKeys }
      : {}),
    ...(params.delegate.fanoutMode ? { fanoutMode: params.delegate.fanoutMode } : {}),
    ...(params.delegate.traceparent ? { traceparent: params.delegate.traceparent } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey:
      params.idempotencyKey ??
      buildPostCompactionDelegateIdempotencyKey({
        sessionKey: params.sessionKey,
        delegate: params.delegate,
        sequence: params.sequence,
        compactionCount: params.compactionCount,
      }),
  };
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => undefined);
}

async function unlinkStaleTmpBestEffort(filePath: string, now: number): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return;
    }
    if (now - stat.mtimeMs < TMP_SWEEP_MAX_AGE_MS) {
      return;
    }
    await unlinkBestEffort(filePath);
  } catch (err) {
    if (getErrnoCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

async function writeQueueEntry(filePath: string, entry: QueuedSessionDelivery): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

async function readQueueEntry(filePath: string): Promise<QueuedSessionDelivery> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as QueuedSessionDelivery;
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
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

export async function ensureSessionDeliveryQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

export async function countQueuedFiles(queueDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return 0;
    }
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".delivered")) {
      count += 1;
    }
  }
  return count;
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
  opts?: { maxQueuedFiles?: number },
): Promise<string> {
  const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
  const id = buildEntryId(params.idempotencyKey);
  const filePath = path.join(queueDir, `${id}.json`);

  if (params.idempotencyKey) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) {
        return id;
      }
    } catch (err) {
      if (getErrnoCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }

  const maxQueuedFiles = opts?.maxQueuedFiles ?? DEFAULT_QUEUE_DIR_MAX_FILES;
  if (Number.isFinite(maxQueuedFiles) && maxQueuedFiles > 0) {
    const count = await countQueuedFiles(queueDir);
    if (count >= maxQueuedFiles) {
      console.warn(
        `[session-delivery-queue] enqueue rejected: ${count} queued files at top level, soft-cap is ${maxQueuedFiles}`,
      );
      throw new SessionDeliveryQueueOverflowError(count, maxQueuedFiles);
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

export async function enqueuePostCompactionDelegateDelivery(
  params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
  },
  stateDir?: string,
  opts?: { maxQueuedFiles?: number },
): Promise<string> {
  return await enqueueSessionDelivery(
    buildPostCompactionDelegateDeliveryPayload(params),
    stateDir,
    opts,
  );
}

export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    await fs.promises.rename(jsonPath, deliveredPath);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      await unlinkBestEffort(deliveredPath);
      return;
    }
    throw err;
  }
  await unlinkBestEffort(deliveredPath);
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

export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    const stat = await fs.promises.stat(jsonPath);
    if (!stat.isFile()) {
      return null;
    }
    return await readQueueEntry(jsonPath);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }

  const now = Date.now();
  for (const file of files) {
    if (file.endsWith(".delivered")) {
      await unlinkBestEffort(path.join(queueDir, file));
    } else if (file.endsWith(".tmp")) {
      await unlinkStaleTmpBestEffort(path.join(queueDir, file), now);
    }
  }

  const entries: QueuedSessionDelivery[] = [];
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
      entries.push(await readQueueEntry(filePath));
    } catch {
      continue;
    }
  }
  return entries;
}

export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}

export async function pruneFailedOlderThan(
  maxAgeMs: number,
  now: number,
  stateDir?: string,
): Promise<{ scanned: number; removed: number }> {
  const failedDir = resolveFailedDir(stateDir);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(failedDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return { scanned: 0, removed: 0 };
    }
    throw err;
  }

  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    const filePath = path.join(failedDir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      scanned += 1;
      if (now - stat.mtimeMs > maxAgeMs) {
        try {
          await fs.promises.unlink(filePath);
          removed += 1;
        } catch (unlinkErr) {
          if (getErrnoCode(unlinkErr) !== "ENOENT") {
            throw unlinkErr;
          }
        }
      }
    } catch (err) {
      if (getErrnoCode(err) === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
  return { scanned, removed };
}
