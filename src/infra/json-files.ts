import fs from "node:fs";
import path from "node:path";
import {
  readRootJsonObjectSync as rawReadRootJsonObjectSync,
  tryReadJsonSync as rawTryReadJsonSync,
} from "@openclaw/fs-safe/json";
import "./fs-safe-defaults.js";
import { replaceFileAtomic } from "./replace-file.js";

// Tension with src/plugins/CLAUDE.md "no persistent metadata caches" — landed
// as a pragmatic floor while the redundant read amplifier upstream is still
// being chased. Remove once the root cause (snapshot/registry rebuild churn,
// see https://github.com/openclaw/openclaw/pull/84351) is fixed.
type CacheEntry = { value: unknown; mtimeMs: bigint; size: bigint; ino: bigint };
const jsonReadCache = new Map<string, CacheEntry>();

function isJsonReadCacheDisabled(): boolean {
  return process.env.OPENCLAW_DISABLE_JSON_READ_CACHE === "1";
}

function statOrUndefined(filePath: string): fs.BigIntStats | undefined {
  try {
    return fs.statSync(filePath, { bigint: true });
  } catch {
    return undefined;
  }
}

function statMatches(entry: CacheEntry, stat: fs.BigIntStats): boolean {
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size && entry.ino === stat.ino;
}

export function clearJsonReadCache(): void {
  jsonReadCache.clear();
}

export const tryReadJsonSync = ((...args: unknown[]) => {
  const filePath = args[0];
  if (typeof filePath !== "string" || isJsonReadCacheDisabled()) {
    return (rawTryReadJsonSync as (...a: unknown[]) => unknown)(...args);
  }
  const key = path.resolve(filePath);
  const stat = statOrUndefined(key);
  if (!stat) {
    jsonReadCache.delete(key);
    return (rawTryReadJsonSync as (...a: unknown[]) => unknown)(...args);
  }
  const entry = jsonReadCache.get(key);
  if (entry && statMatches(entry, stat)) {
    return entry.value;
  }
  const result = (rawTryReadJsonSync as (...a: unknown[]) => unknown)(...args);
  if (result !== null && result !== undefined) {
    jsonReadCache.set(key, {
      value: result,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
    });
  }
  return result;
}) as typeof rawTryReadJsonSync;
export const readJsonFileSync = tryReadJsonSync;

export const readRootJsonObjectSync = ((...args: unknown[]) => {
  const params = args[0];
  if (!params || typeof params !== "object" || isJsonReadCacheDisabled()) {
    return (rawReadRootJsonObjectSync as (...a: unknown[]) => unknown)(...args);
  }
  const rootDir = (params as { rootDir?: unknown }).rootDir;
  const relativePath = (params as { relativePath?: unknown }).relativePath;
  if (typeof rootDir !== "string" || typeof relativePath !== "string") {
    return (rawReadRootJsonObjectSync as (...a: unknown[]) => unknown)(...args);
  }
  const key = path.resolve(rootDir, relativePath);
  const stat = statOrUndefined(key);
  if (!stat) {
    jsonReadCache.delete(key);
    return (rawReadRootJsonObjectSync as (...a: unknown[]) => unknown)(...args);
  }
  const entry = jsonReadCache.get(key);
  if (entry && statMatches(entry, stat)) {
    return entry.value;
  }
  const result = (rawReadRootJsonObjectSync as (...a: unknown[]) => unknown)(...args);
  if (result && typeof result === "object" && (result as { ok?: unknown }).ok === true) {
    jsonReadCache.set(key, {
      value: result,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
    });
  }
  return result;
}) as typeof rawReadRootJsonObjectSync;

export {
  JsonFileReadError,
  readJson,
  readJson as readJsonFileStrict,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile,
  readJsonSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJson,
  tryReadJson as readJsonFile,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
} from "@openclaw/fs-safe/json";
export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
};

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
  });
}
