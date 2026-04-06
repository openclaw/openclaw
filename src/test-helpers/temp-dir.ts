import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempDir<T>(
  options: {
    prefix: string;
    parentDir?: string;
    subdir?: string;
  },
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const base = await fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
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
  const base = fsSync.mkdtempSync(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
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
