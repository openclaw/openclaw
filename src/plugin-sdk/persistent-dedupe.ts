import { createDedupeCache } from "../infra/dedupe.js";
import type { FileLockOptions } from "./file-lock.js";
import { withFileLock } from "./file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";

type PersistentDedupeData = Record<string, number>;

export type PersistentDedupeOptions = {
  ttlMs: number;
  memoryMaxSize: number;
  fileMaxEntries: number;
  resolveFilePath: (namespace: string) => string;
  lockOptions?: Partial<FileLockOptions>;
  onDiskError?: (error: unknown) => void;
};

export type PersistentDedupeCheckOptions = {
  namespace?: string;
  now?: number;
  onDiskError?: (error: unknown) => void;
};

export type PersistentDedupe = {
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  clearMemory: () => void;
  memorySize: () => number;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

function mergeLockOptions(overrides?: Partial<FileLockOptions>): FileLockOptions {
  return {
    stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
    retries: {
      retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
      factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
      minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
      maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
      randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize,
    },
  };
}

function sanitizeData(value: unknown): PersistentDedupeData {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: PersistentDedupeData = {};
  for (const [key, ts] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      out[key] = ts;
    }
  }
  return out;
}

function pruneData(
  data: PersistentDedupeData,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void {
  if (ttlMs > 0) {
    for (const [key, ts] of Object.entries(data)) {
      if (now - ts >= ttlMs) {
        delete data[key];
      }
    }
  }

  const keys = Object.keys(data);
  if (keys.length <= maxEntries) {
    return;
  }

  keys
    .toSorted((a, b) => data[a] - data[b])
    .slice(0, keys.length - maxEntries)
    .forEach((key) => {
      delete data[key];
    });
}

export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
  const lockOptions = mergeLockOptions(options.lockOptions);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();

  async function checkAndRecordInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onDiskError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.check(scopedKey, now)) {
      return false;
    }

    const path = options.resolveFilePath(namespace);
    try {
      const duplicate = await withFileLock(path, lockOptions, async () => {
        const { value } = await readJsonFileWithFallback<PersistentDedupeData>(path, {});
        const data = sanitizeData(value);
        const seenAt = data[key];
        const isRecent = seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
        if (isRecent) {
          return true;
        }
        data[key] = now;
        pruneData(data, now, ttlMs, fileMaxEntries);
        await writeJsonFileAtomically(path, data);
        return false;
      });
      return !duplicate;
    } catch (error) {
      onDiskError?.(error);
      return true;
    }
  }

  async function checkAndRecord(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = dedupeOptions?.namespace?.trim() || "global";
    const scopedKey = `${namespace}:${trimmed}`;
    if (inflight.has(scopedKey)) {
      return false;
    }

    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    const work = checkAndRecordInner(trimmed, namespace, scopedKey, now, onDiskError);
    inflight.set(scopedKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  return {
    checkAndRecord,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}
