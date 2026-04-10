import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const asyncPrefixRoots = new Map<string, string>();
const pendingAsyncPrefixRoots = new Map<string, Promise<string>>();
const syncPrefixRoots = new Map<string, string>();
let nextAsyncDirIndex = 0;
let nextSyncDirIndex = 0;

function getRootKey(options: { prefix: string; parentDir?: string }): string {
  return `${options.parentDir ?? os.tmpdir()}\u0000${options.prefix}`;
}

async function ensureAsyncPrefixRoot(options: {
  prefix: string;
  parentDir?: string;
}): Promise<string> {
  const key = getRootKey(options);
  const cached = asyncPrefixRoots.get(key);
  if (cached) {
    return cached;
  }
  const pending = pendingAsyncPrefixRoots.get(key);
  if (pending) {
    return await pending;
  }
  const create = fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
  pendingAsyncPrefixRoots.set(key, create);
  try {
    const root = await create;
    asyncPrefixRoots.set(key, root);
    return root;
  } finally {
    pendingAsyncPrefixRoots.delete(key);
  }
}

function ensureSyncPrefixRoot(options: { prefix: string; parentDir?: string }): string {
  const key = getRootKey(options);
  const cached = syncPrefixRoots.get(key);
  if (cached) {
    return cached;
  }
  const root = fsSync.mkdtempSync(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
  syncPrefixRoots.set(key, root);
  return root;
}

export async function withTempDir<T>(
  options: {
    prefix: string;
    parentDir?: string;
    subdir?: string;
  },
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const root = await ensureAsyncPrefixRoot(options);
  const base = path.join(root, `dir-${String(nextAsyncDirIndex)}`);
  nextAsyncDirIndex += 1;
  await fs.mkdir(base, { recursive: true });
  const dir = options.subdir ? path.join(base, options.subdir) : base;
  if (options.subdir) {
    await fs.mkdir(dir, { recursive: true });
  }
  try {
    return await run(dir);
  } finally {
    await fs.rm(base, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
  }
}

export function createSuiteTempRootTracker(options: { prefix: string; parentDir?: string }) {
  let root = "";
  let nextIndex = 0;

  return {
    async setup(): Promise<string> {
      root = await fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
      nextIndex = 0;
      return root;
    },
    async make(prefix = "case"): Promise<string> {
      const dir = path.join(root, `${prefix}-${nextIndex++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(): Promise<void> {
      if (!root) {
        return;
      }
      const currentRoot = root;
      root = "";
      nextIndex = 0;
      await fs.rm(currentRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
    },
  };
}

export function withTempDirSync<T>(
  options: {
    prefix: string;
    parentDir?: string;
    subdir?: string;
  },
  run: (dir: string) => T,
): T {
  const root = ensureSyncPrefixRoot(options);
  const base = path.join(root, `dir-${String(nextSyncDirIndex)}`);
  nextSyncDirIndex += 1;
  fsSync.mkdirSync(base, { recursive: true });
  const dir = options.subdir ? path.join(base, options.subdir) : base;
  if (options.subdir) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  try {
    return run(dir);
  } finally {
    fsSync.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
  }
}
