import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Share canonical roots per prefix, avoiding macOS /var symlink mismatches.
// Private case directories admit secure filesystem helpers under permissive umasks.
type PrefixRootState = { path: string; activeCount: number };
type RootOptions = { prefix: string; parentDir?: string };
type DirOptions = RootOptions & { subdir?: string };
const removeOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 };

const asyncPrefixRoots = new Map<string, PrefixRootState>();
const pendingAsyncPrefixRoots = new Map<string, Promise<PrefixRootState>>();
const syncPrefixRoots = new Map<string, PrefixRootState>();
let nextAsyncDirIndex = 0;
let nextSyncDirIndex = 0;

function getRootKey(options: RootOptions): string {
  return `${options.parentDir ?? os.tmpdir()}\u0000${options.prefix}`;
}

async function acquireAsyncPrefixRoot(options: RootOptions): Promise<PrefixRootState> {
  const key = getRootKey(options);
  const cached = asyncPrefixRoots.get(key);
  if (cached) {
    cached.activeCount += 1;
    return cached;
  }
  let pending = pendingAsyncPrefixRoots.get(key);
  if (!pending) {
    // Concurrent cases acquire the same in-flight root.
    pending = fs
      .mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix))
      .then((root) => fs.realpath(root))
      .then((root) => ({ path: root, activeCount: 0 }));
    pendingAsyncPrefixRoots.set(key, pending);
  }
  try {
    const state = await pending;
    asyncPrefixRoots.set(key, state);
    state.activeCount += 1;
    return state;
  } finally {
    pendingAsyncPrefixRoots.delete(key);
  }
}

function releasePrefixRoot(roots: Map<string, PrefixRootState>, options: RootOptions) {
  const key = getRootKey(options);
  const state = roots.get(key);
  if (!state || --state.activeCount > 0) {
    return undefined;
  }
  roots.delete(key);
  return state;
}

export async function withTestDir<T>(options: DirOptions, run: (dir: string) => Promise<T>) {
  const root = await acquireAsyncPrefixRoot(options);
  const base = path.join(root.path, `dir-${nextAsyncDirIndex++}`);
  try {
    const dir = options.subdir ? path.join(base, options.subdir) : base;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run(dir);
  } finally {
    await fs.rm(base, removeOptions);
    const released = releasePrefixRoot(asyncPrefixRoots, options);
    if (released) {
      await fs.rm(released.path, removeOptions);
    }
  }
}

// Stable suite root with isolated children.
export function createSuiteTempRootTracker(options: RootOptions) {
  let root = "";
  let nextIndex = 0;

  return {
    setup: async (): Promise<string> => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix)),
      );
      nextIndex = 0;
      return root;
    },
    make: async (prefix = "case"): Promise<string> => {
      const dir = path.join(root, `${prefix}-${nextIndex++}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    cleanup: async (): Promise<void> => {
      if (!root) {
        return;
      }
      const currentRoot = root;
      root = "";
      nextIndex = 0;
      await fs.rm(currentRoot, removeOptions);
    },
  };
}

export function withTempDirSync<T>(options: DirOptions, run: (dir: string) => T): T {
  const key = getRootKey(options);
  const root = syncPrefixRoots.get(key) ?? {
    path: fsSync.realpathSync(
      fsSync.mkdtempSync(path.join(options.parentDir ?? os.tmpdir(), options.prefix)),
    ),
    activeCount: 0,
  };
  syncPrefixRoots.set(key, root);
  root.activeCount += 1;
  const base = path.join(root.path, `dir-${nextSyncDirIndex++}`);
  try {
    const dir = options.subdir ? path.join(base, options.subdir) : base;
    fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return run(dir);
  } finally {
    fsSync.rmSync(base, removeOptions);
    const released = releasePrefixRoot(syncPrefixRoots, options);
    if (released) {
      fsSync.rmSync(released.path, removeOptions);
    }
  }
}
