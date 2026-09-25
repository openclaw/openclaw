// Wraps fs-safe JSON reads and atomic writes with OpenClaw defaults.
import {
  replaceFileAtomic,
  type ReplaceFileAtomicOptions,
  type WriteTextAtomicOptions as FsSafeWriteTextAtomicOptions,
} from "@openclaw/fs-safe/atomic";

export {
  JsonFileReadError,
  readJson,
  readJson as readJsonFileStrict, // Sanctioned domain alias.
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile, // Sanctioned domain alias.
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJson,
  tryReadJson as readJsonFile, // Sanctioned domain alias.
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync, // Sanctioned domain alias.
  writeJson,
  writeJson as writeJsonAtomic, // Sanctioned domain alias.
  writeJsonSync,
} from "@openclaw/fs-safe/json";

export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type WriteTextAtomicOptions = FsSafeWriteTextAtomicOptions &
  Pick<ReplaceFileAtomicOptions, "beforeRename" | "tempPrefix">;

/** Writes text through the repo atomic replace helper with durable fsync by default. */
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
