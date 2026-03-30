import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function getTempDirCleanupOptions(): Parameters<typeof fs.rm>[1] {
  if (process.platform === "win32") {
    return {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    };
  }
  return {
    recursive: true,
    force: true,
  };
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, getTempDirCleanupOptions());
}

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
    await removeTempDir(base);
  }
}
