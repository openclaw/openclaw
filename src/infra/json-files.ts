import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function isWindowsFileReplaceError(error: unknown): boolean {
  if (process.platform !== "win32" || !error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function replaceFileWithRetry(tmpPath: string, filePath: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isWindowsFileReplaceError(error) || attempt === 4) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  if (isWindowsFileReplaceError(lastError)) {
    await fs.copyFile(tmpPath, filePath);
    return;
  }
  throw lastError;
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
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
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, payload, { encoding: "utf8", mode });
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithRetry(tmp, filePath);
    try {
      await fs.chmod(filePath, mode);
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
