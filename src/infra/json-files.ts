import "./fs-safe-defaults.js";
import {
  JsonFileReadError,
  readJson as readJsonImpl,
  readJsonIfExists as readJsonIfExistsImpl,
} from "@openclaw/fs-safe/json";
import { replaceFileAtomic } from "./replace-file.js";

type WriteTextAtomicBeforeRename = (params: {
  filePath: string;
  tempPath: string;
}) => Promise<void>;

export {
  JsonFileReadError,
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
} from "@openclaw/fs-safe/json";

/** Read and parse JSON, wrapping non-fs-safe failures with file-path context. */
export async function readJson<T>(filePath: string): Promise<T> {
  try {
    return await readJsonImpl<T>(filePath);
  } catch (err) {
    throw err instanceof JsonFileReadError ? err : new JsonFileReadError(filePath, "read", err);
  }
}

/** Strict JSON reader alias for call sites that want missing or invalid files to throw. */
export async function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readJson<T>(filePath);
}

/** Read JSON when present; missing files return null, malformed files still throw. */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonIfExistsImpl<T>(filePath);
  } catch (err) {
    if (err instanceof JsonFileReadError) {
      throw err;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
}

/** Durable optional JSON read used by stores where corrupt files must surface. */
export async function readDurableJsonFile<T>(filePath: string): Promise<T | null> {
  return readJsonIfExists<T>(filePath);
}

/**
 * tryReadJson delegates to readJsonIfExists instead of the internal
 * tryReadJsonImpl from @openclaw/fs-safe. The fs-safe implementation retries
 * race conditions before propagating errors; this wrapper keeps the historical
 * null-on-error contract for callers that intentionally treat reads as optional.
 */
export async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonIfExists<T>(filePath);
  } catch {
    return null;
  }
}

/** Backwards-compatible soft JSON reader: missing, invalid, or racing files return null. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  return tryReadJson<T>(filePath);
}

/** Creates a process-local FIFO async lock; use file locks for cross-process writes. */
export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
  beforeRename?: WriteTextAtomicBeforeRename;
  /**
   * Prefix for the staged `<prefix>.<pid>.<uuid>.tmp` file. Defaults to the
   * generic `.fs-safe-replace`; pass a target-specific prefix so an orphaned
   * temp (from a crash between write and rename) is identifiable and reclaimable.
   */
  tempPrefix?: string;
};

/** Atomically replace text files with secure defaults and optional durability fsyncs. */
export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  await replaceFileAtomic({
    filePath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? 0o777 & ~process.umask(),
    copyFallbackOnPermissionError: true,
    syncTempFile: options?.durable !== false,
    syncParentDir: options?.durable !== false,
    ...(options?.beforeRename ? { beforeRename: options.beforeRename } : {}),
    ...(options?.tempPrefix ? { tempPrefix: options.tempPrefix } : {}),
  });
}
