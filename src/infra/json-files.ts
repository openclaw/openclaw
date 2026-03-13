import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  // On macOS and some Linux configurations, fs.mkdir({ recursive: true }) may
  // ignore the mode option.  Explicitly chmod the directory afterward to ensure
  // it carries the requested permissions regardless of platform behavior.
  if (typeof options?.ensureDirMode === "number") {
    try {
      await fs.chmod(path.dirname(filePath), options.ensureDirMode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  }
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    // Create the temp file with the target mode so the payload is never
    // visible with permissive permissions, even briefly.  The subsequent
    // chmod is kept as a best-effort safety net for platforms that apply
    // umask to the open(2) call (e.g. some Linux configurations).
    await fs.writeFile(tmp, payload, { encoding: "utf8", mode });
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
