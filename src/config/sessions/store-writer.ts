import fs from "node:fs/promises";
import path from "node:path";
import { type FileLockOptions, withFileLock } from "../../plugin-sdk/file-lock.js";
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

const DEFAULT_SESSION_STORE_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

async function ensureSessionStoreDir(storePath: string): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
}

export async function withSessionStoreWriterForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, fn);
}

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveSessionStoreWrite",
    fn: async () => {
      await ensureSessionStoreDir(storePath);
      return await withFileLock(storePath, DEFAULT_SESSION_STORE_LOCK_OPTIONS, fn);
    },
  });
}
