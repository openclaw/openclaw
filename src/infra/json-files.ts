import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

/** Maximum file size (10 MB) for readJsonFile to guard against unbounded reads. */
const MAX_JSON_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    // Read the raw buffer first, then check its byte length before parsing.
    // A separate stat() + readFile() pair is vulnerable to TOCTOU: an attacker
    // could replace the file with a much larger one between the two calls,
    // bypassing the size guard entirely (Aisle Low: CWE-367 TOCTOU).
    // Reading into a Buffer first bounds the allocation check to the actual bytes read.
    const buf = await fs.readFile(filePath).catch(() => null);
    if (!buf) {
      return null;
    }
    if (buf.byteLength > MAX_JSON_FILE_SIZE_BYTES) {
      return null;
    }
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, mkdirOptions);
  // On macOS and some Linux configurations, fs.mkdir({ recursive: true }) may
  // ignore the mode option.  Explicitly chmod the directory afterward to ensure
  // it carries the requested permissions regardless of platform behavior.
  // Use lstat to verify the directory is not a symlink before chmod to prevent
  // symlink-following permission changes on attacker-controlled paths.
  if (typeof options?.ensureDirMode === "number") {
    try {
      const dirStat = await fs.lstat(dir);
      if (dirStat.isDirectory()) {
        await fs.chmod(dir, options.ensureDirMode);
      }
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  }
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      // Use lstat to verify the temp file is not a symlink before chmod.
      const tmpStat = await fs.lstat(tmp);
      if (tmpStat.isFile()) {
        await fs.chmod(tmp, mode);
      }
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const finalStat = await fs.lstat(filePath);
      if (finalStat.isFile()) {
        await fs.chmod(filePath, mode);
      }
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
