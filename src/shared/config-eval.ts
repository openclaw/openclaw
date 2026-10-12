import fs from "node:fs";
import path from "node:path";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { getOrCreatePromise } from "./lazy-promise.js";
import type { RequirementsMetadata } from "./requirements.js";

/** Checks a config path with fallback defaults only when the path is unresolved. */
export function isConfigPathTruthyWithDefaults(
  config: unknown,
  pathStr: string,
  defaults: Record<string, boolean>,
): boolean {
  const parts = pathStr.split(".").filter(Boolean);
  let value: unknown = config;
  for (const part of parts) {
    if (typeof value !== "object" || value === null || isBlockedObjectKey(part)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[part];
  }
  if (
    value === undefined &&
    !parts.some((part) => isBlockedObjectKey(part)) &&
    Object.hasOwn(defaults, pathStr)
  ) {
    return defaults[pathStr] ?? false;
  }
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null && value !== false && value !== 0;
}

/** Enforces OS compatibility before allowing `always` to bypass runtime requirements. */
export function evaluateRuntimeEligibility(
  params: RequirementsMetadata & {
    platform?: string;
    remotePlatforms?: string[];
    always?: boolean;
    hasBin: (bin: string) => boolean;
    hasAnyRemoteBin?: (bins: string[]) => boolean;
    hasRemoteBin?: (bin: string) => boolean;
    hasEnv: (envName: string) => boolean;
    isConfigPathTruthy: (pathStr: string) => boolean;
  },
): boolean {
  const osList = params.os ?? [];
  if (
    osList.length > 0 &&
    !osList.includes(params.platform ?? process.platform) &&
    !params.remotePlatforms?.some((platform) => osList.includes(platform))
  ) {
    return false;
  }
  const requires = params.requires;
  if (params.always === true || !requires) {
    return true;
  }
  for (const envName of requires.env ?? []) {
    if (!params.hasEnv(envName)) {
      return false;
    }
  }
  for (const configPath of requires.config ?? []) {
    if (!params.isConfigPathTruthy(configPath)) {
      return false;
    }
  }
  for (const bin of requires.bins ?? []) {
    if (!params.hasBin(bin) && !params.hasRemoteBin?.(bin)) {
      return false;
    }
  }
  const requiredAnyBins = requires.anyBins ?? [];
  return (
    requiredAnyBins.length === 0 ||
    requiredAnyBins.some((bin) => params.hasBin(bin)) ||
    Boolean(params.hasAnyRemoteBin?.(requiredAnyBins))
  );
}

function windowsPathExtensions(raw: string | undefined): string[] {
  const list =
    raw !== undefined ? raw.split(";").map((v) => v.trim()) : [".EXE", ".CMD", ".BAT", ".COM"];
  return ["", ...list.filter(Boolean)];
}

// Share pending I/O only so completed misses are checked again on the next preparation.
const pendingBinaryAccess = new Map<string, Promise<void>>();

// Installs can create binaries under unchanged PATH/PATHEXT, so cache only successful probes.
let binaryCache: { path: string; pathExt: string; hits: Set<string> } | undefined;

function resolveBinaryCache() {
  const isWindows = process.platform === "win32";
  const pathEnv = process.env.PATH ?? "";
  const pathExt = isWindows ? (process.env.PATHEXT ?? "") : "";
  if (binaryCache?.path !== pathEnv || binaryCache.pathExt !== pathExt) {
    binaryCache = { path: pathEnv, pathExt, hits: new Set() };
  }
  return binaryCache;
}

function resolveBinarySearch(cache = resolveBinaryCache()) {
  const isWindows = process.platform === "win32";
  return {
    cache,
    isWindows,
    pathExt: isWindows ? process.env.PATHEXT : undefined,
    parts: cache.path.split(path.delimiter).filter(Boolean),
    extensions: isWindows ? windowsPathExtensions(process.env.PATHEXT) : [""],
  };
}

function* binaryCandidates(search: ReturnType<typeof resolveBinarySearch>, bin: string) {
  for (const part of search.parts) {
    for (const ext of search.extensions) {
      yield path.join(part, bin + ext);
    }
  }
}

export function hasBinary(bin: string): boolean {
  const cache = resolveBinaryCache();
  if (cache.hits.has(bin)) {
    return true;
  }
  const search = resolveBinarySearch(cache);
  for (const candidate of binaryCandidates(search, bin)) {
    try {
      // Avoid missing-file errors without changing Windows symlink checks.
      if (!search.isWindows && !fs.existsSync(candidate)) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      search.cache.hits.add(bin);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/** Binary facts belong to one preparation; missing tools are probed again on the next build. */
export async function prepareBinaryAvailability(
  bins: Iterable<string>,
  assertCurrent?: () => void,
): Promise<{ hasBinary: (bin: string) => boolean; isCurrent: () => boolean }> {
  const search = resolveBinarySearch();
  const cwd = process.cwd();
  const pending = new Set(bins).values();
  const available = new Set<string>();
  let failure: { error: unknown } | undefined;
  const isCurrent = () =>
    (process.env.PATH ?? "") === search.cache.path &&
    (search.isWindows ? process.env.PATHEXT : undefined) === search.pathExt &&
    process.cwd() === cwd;
  const probe = async (bin: string) => {
    if (search.cache.hits.has(bin)) {
      available.add(bin);
      return;
    }
    for (const candidate of binaryCandidates(search, bin)) {
      if (failure || !isCurrent()) {
        return;
      }
      assertCurrent?.();
      try {
        // access uses the filesystem's case, permission, and symlink semantics.
        const resolvedCandidate = path.resolve(cwd, candidate);
        await getOrCreatePromise(
          pendingBinaryAccess,
          resolvedCandidate,
          () => fs.promises.access(resolvedCandidate, fs.constants.X_OK),
          { evictOnSettled: true },
        );
      } catch {
        continue;
      }
      assertCurrent?.();
      if (isCurrent()) {
        available.add(bin);
        // A concurrent lookup may have replaced the shared PATH cache while this awaited.
        if (binaryCache === search.cache) {
          search.cache.hits.add(bin);
        }
      }
      return;
    }
  };
  const worker = async () => {
    try {
      for (;;) {
        if (failure || !isCurrent()) {
          return;
        }
        assertCurrent?.();
        const next = pending.next();
        if (next.done) {
          return;
        }
        await probe(next.value);
      }
    } catch (error) {
      failure ??= { error };
    }
  };
  // Leave filesystem work bounded even when many skills require different missing tools.
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failure) {
    throw failure.error;
  }
  assertCurrent?.();
  return { hasBinary: (bin) => available.has(bin), isCurrent };
}
