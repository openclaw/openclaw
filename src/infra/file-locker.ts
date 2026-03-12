import { createAsyncLock } from "../utils/async-lock";

// Type definition for file locks
type FileLock = {
  lock: ReturnType<typeof createAsyncLock>;
  refCount: number;
};

// Singleton file locker to manage locks per file path
class FileLocker {
  private static instance: FileLocker;
  private locks: Map<string, FileLock> = new Map();

  private constructor() {}

  public static getInstance(): FileLocker {
    if (!FileLocker.instance) {
      FileLocker.instance = new FileLocker();
    }
    return FileLocker.instance;
  }

  /**
   * Acquires a lock for a specific file path
   * @param filePath The path to the file to lock
   * @param fn The function to execute while holding the lock
   * @returns Promise that resolves to the result of fn
   */
  async acquire<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    let fileLock = this.locks.get(filePath);

    if (!fileLock) {
      fileLock = {
        lock: createAsyncLock(),
        refCount: 0,
      };
      this.locks.set(filePath, fileLock);
    }

    // Increment reference count
    fileLock.refCount++;

    try {
      return await fileLock.lock(fn);
    } finally {
      // Decrement reference count and clean up if no more references
      fileLock.refCount--;
      if (fileLock.refCount <= 0) {
        this.locks.delete(filePath);
      }
    }
  }

  /**
   * Checks if a file is currently locked
   * @param filePath The path to check
   * @returns True if the file is locked, false otherwise
   */
  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  /**
   * Gets the number of locks held for a file
   * @param filePath The path to check
   * @returns The reference count for the file lock
   */
  getRefCount(filePath: string): number {
    const fileLock = this.locks.get(filePath);
    return fileLock ? fileLock.refCount : 0;
  }
}

export const fileLocker = FileLocker.getInstance();

/**
 * Utility function to safely write to a file with locking
 * @param filePath The path to the file to write to
 * @param content The content to write
 * @param options Additional options for writing
 * @returns Promise that resolves when write is complete
 */
export async function writeToFileWithLock(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; trailingNewline?: boolean },
): Promise<void> {
  return await fileLocker.acquire(filePath, async () => {
    // This would integrate with the existing writeTextAtomic function
    // from the json-files module, but since we're creating a new source
    // structure, we'll implement the functionality here
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const crypto = await import("node:crypto");

    const mode = options?.mode ?? 0o600; // Default to owner-only read/write
    const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;

    const mkdirOptions = { recursive: true };
    if (typeof options?.ensureDirMode === "number") {
      mkdirOptions.mode = options.ensureDirMode;
    }

    await fs.mkdir(path.dirname(filePath), mkdirOptions);
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;

    try {
      await fs.writeFile(tmp, payload, "utf8");

      try {
        await fs.chmod(tmp, mode);
      } catch {}

      await fs.rename(tmp, filePath);

      try {
        await fs.chmod(filePath, mode);
      } catch {}
    } finally {
      try {
        await fs.rm(tmp, { force: true }).catch(() => {});
      } catch {}
    }
  });
}

/**
 * Utility function to read from a file with locking to prevent conflicts
 * @param filePath The path to the file to read from
 * @returns Promise that resolves to the file content
 */
export async function readFromFileWithLock(filePath: string): Promise<string | null> {
  return await fileLocker.acquire(filePath, async () => {
    const fs = await import("node:fs/promises");

    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  });
}
