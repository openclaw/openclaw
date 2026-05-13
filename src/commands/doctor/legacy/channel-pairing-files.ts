import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../../../config/paths.js";
import { resolveRequiredHomeDir } from "../../../infra/home-dir.js";
import {
  safeAccountKey,
  safeChannelKey,
  type AllowFromStore,
} from "../../../pairing/pairing-store-keys.js";
import type { PairingChannel } from "../../../pairing/pairing-store.types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";

type AllowFromReadCacheEntry = {
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  entries: string[];
};

type AllowFromStatLike = { mtimeMs: number; size: number } | null;
type NormalizeAllowFromStore = (store: AllowFromStore) => string[];

const allowFromReadCache = new Map<string, AllowFromReadCacheEntry>();

export function resolveLegacyPairingCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

function resolveOptionalAccountFilenameKey(accountId: unknown): string | null {
  if (accountId == null) {
    return null;
  }
  if (typeof accountId !== "string") {
    throw new Error(
      `invalid pairing account id: expected non-empty string; got ${typeof accountId}`,
    );
  }
  const normalizedAccountId = normalizeOptionalString(accountId) ?? "";
  return normalizedAccountId ? safeAccountKey(normalizedAccountId) : null;
}

export function resolveLegacyChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const accountKey = resolveOptionalAccountFilenameKey(accountId);
  if (!accountKey) {
    return path.join(resolveLegacyPairingCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(resolveLegacyPairingCredentialsDir(env), `${base}-${accountKey}-allowFrom.json`);
}

function cloneAllowFromCacheEntry(entry: AllowFromReadCacheEntry): AllowFromReadCacheEntry {
  return {
    exists: entry.exists,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    entries: entry.entries.slice(),
  };
}

function resolveAllowFromCacheKey(cacheNamespace: string, filePath: string): string {
  return `${cacheNamespace}\u0000${filePath}`;
}

function setAllowFromFileReadCache(params: {
  cacheNamespace: string;
  filePath: string;
  entry: AllowFromReadCacheEntry;
}): void {
  allowFromReadCache.set(
    resolveAllowFromCacheKey(params.cacheNamespace, params.filePath),
    cloneAllowFromCacheEntry(params.entry),
  );
}

function resolveAllowFromReadCacheHit(params: {
  cacheNamespace: string;
  filePath: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}): AllowFromReadCacheEntry | null {
  const cached = allowFromReadCache.get(
    resolveAllowFromCacheKey(params.cacheNamespace, params.filePath),
  );
  if (!cached) {
    return null;
  }
  if (cached.exists !== params.exists) {
    return null;
  }
  if (!params.exists) {
    return cloneAllowFromCacheEntry(cached);
  }
  if (cached.mtimeMs !== params.mtimeMs || cached.size !== params.size) {
    return null;
  }
  return cloneAllowFromCacheEntry(cached);
}

function resolveAllowFromReadCacheOrMissing(params: {
  cacheNamespace: string;
  filePath: string;
  stat: AllowFromStatLike;
}): { entries: string[]; exists: boolean } | null {
  const cached = resolveAllowFromReadCacheHit({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    exists: Boolean(params.stat),
    mtimeMs: params.stat?.mtimeMs ?? null,
    size: params.stat?.size ?? null,
  });
  if (cached) {
    return { entries: cached.entries, exists: cached.exists };
  }
  if (!params.stat) {
    setAllowFromFileReadCache({
      cacheNamespace: params.cacheNamespace,
      filePath: params.filePath,
      entry: {
        exists: false,
        mtimeMs: null,
        size: null,
        entries: [],
      },
    });
    return { entries: [], exists: false };
  }
  return null;
}

export async function readAllowFromFileWithExists(params: {
  cacheNamespace: string;
  filePath: string;
  normalizeStore: NormalizeAllowFromStore;
}): Promise<{ entries: string[]; exists: boolean }> {
  let stat: Awaited<ReturnType<typeof fs.promises.stat>> | null = null;
  try {
    stat = await fs.promises.stat(params.filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const cachedOrMissing = resolveAllowFromReadCacheOrMissing({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    stat,
  });
  if (cachedOrMissing) {
    return cachedOrMissing;
  }
  if (!stat) {
    return { entries: [], exists: false };
  }

  let raw = "";
  try {
    raw = await fs.promises.readFile(params.filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { entries: [], exists: false };
    }
    throw err;
  }

  let entries: string[] = [];
  try {
    entries = params.normalizeStore(JSON.parse(raw) as AllowFromStore);
  } catch {
    entries = [];
  }
  setAllowFromFileReadCache({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    entry: {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries,
    },
  });
  return { entries, exists: true };
}
