import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const FILE_LOCK_ERRORS = new Set(["EBUSY", "EACCES", "EPERM"]);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

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

  const attemptWrite = async (): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), mkdirOptions);
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, payload, "utf8");
      try {
        await fs.chmod(tmp, mode);
      } catch {
        // best-effort; ignore on platforms without chmod
      }
      await fs.rename(tmp, filePath);
      try {
        await fs.chmod(filePath, mode);
      } catch {
        // best-effort; ignore on platforms without chmod
      }
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await attemptWrite();
      return;
    } catch (err) {
      lastError = err as Error;
      const errWithCode = err as { code?: string };
      if (attempt < MAX_RETRIES - 1 && FILE_LOCK_ERRORS.has(errWithCode.code ?? "")) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
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
