import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";
import {
  WRITER_QUEUES,
  type SessionStoreWriterQueue,
  type SessionStoreWriterTask,
} from "./store-writer-state.js";

const DEFAULT_FILE_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_FILE_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_FILE_LOCK_POLL_MS = 25;
const ORPHAN_LOCK_PAYLOAD_GRACE_MS = 5_000;

type SessionStoreLockPayload = {
  pid?: number;
  threadId?: number;
  hostname?: string;
  createdAt?: string;
  token?: string;
};

export async function withSessionStoreWriterForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, fn);
}

function resolvePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSessionStoreLockPath(storePath: string): string {
  return `${path.resolve(storePath)}.lock`;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readSessionStoreLockPayload(
  lockPath: string,
): Promise<SessionStoreLockPayload | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8")) as SessionStoreLockPayload;
  } catch {
    return null;
  }
}

async function isSessionStoreLockStale(
  lockPath: string,
  payload: SessionStoreLockPayload | null,
  staleMs: number,
): Promise<boolean> {
  if (!payload?.createdAt) {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) {
      return true;
    }
    return Date.now() - stat.mtimeMs > ORPHAN_LOCK_PAYLOAD_GRACE_MS;
  }
  const createdAtMs = Date.parse(payload.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) {
      return true;
    }
    return Date.now() - stat.mtimeMs > ORPHAN_LOCK_PAYLOAD_GRACE_MS;
  }
  return Date.now() - createdAtMs > staleMs;
}

async function removeStaleSessionStoreLock(
  lockPath: string,
  expectedToken: string | undefined,
): Promise<void> {
  if (!expectedToken) {
    await fs.rm(lockPath, { force: true });
    return;
  }
  const current = await readSessionStoreLockPayload(lockPath);
  if (current?.token === expectedToken) {
    await fs.rm(lockPath, { force: true });
  }
}

async function acquireSessionStoreFileLock(storePath: string): Promise<() => Promise<void>> {
  const lockPath = resolveSessionStoreLockPath(storePath);
  const timeoutMs = resolvePositiveMs(
    process.env.OPENCLAW_SESSION_STORE_LOCK_TIMEOUT_MS,
    DEFAULT_FILE_LOCK_TIMEOUT_MS,
  );
  const staleMs = resolvePositiveMs(
    process.env.OPENCLAW_SESSION_STORE_LOCK_STALE_MS,
    DEFAULT_FILE_LOCK_STALE_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const payload: SessionStoreLockPayload = {
    pid: process.pid,
    threadId,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    token: randomUUID(),
  };

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.close();
      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        await removeStaleSessionStoreLock(lockPath, payload.token).catch(() => undefined);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }

      const existing = await readSessionStoreLockPayload(lockPath);
      if (await isSessionStoreLockStale(lockPath, existing, staleMs)) {
        await removeStaleSessionStoreLock(lockPath, existing?.token).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for session store writer lock: ${lockPath} ` +
            `(owner pid=${existing?.pid ?? "unknown"} thread=${existing?.threadId ?? "unknown"})`,
          { cause: error },
        );
      }
      await sleep(DEFAULT_FILE_LOCK_POLL_MS);
    }
  }
}

async function runWithSessionStoreFileLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireSessionStoreFileLock(storePath);
  try {
    return await fn();
  } finally {
    await release();
  }
}

function getOrCreateWriterQueue(storePath: string): SessionStoreWriterQueue {
  const existing = WRITER_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreWriterQueue = { running: false, pending: [], drainPromise: null };
  WRITER_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreWriterQueue(storePath: string): Promise<void> {
  const queue = WRITER_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }

        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        try {
          result = await runWithSessionStoreFileLock(storePath, task.fn);
        } catch (err) {
          hasFailure = true;
          failed = err;
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        WRITER_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainSessionStoreWriterQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `runExclusiveSessionStoreWrite: storePath must be a non-empty string, got ${JSON.stringify(
        storePath,
      )}`,
    );
  }
  const queue = getOrCreateWriterQueue(storePath);

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreWriterTask = {
      fn: async () => await fn(),
      resolve: (value) => resolve(value as T),
      reject,
    };

    queue.pending.push(task);
    void drainSessionStoreWriterQueue(storePath);
  });

  return await promise;
}
