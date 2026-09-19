// Config evaluation helpers load dynamic config modules with guarded evaluation.
import fs from "node:fs";
import path from "node:path";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { getOrCreatePromise } from "./lazy-promise.js";

/** Normalizes primitive config values into the truthiness rules used by requirements checks. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

/** Resolves dotted config paths, tolerating extra dots and missing branches. */
function resolveConfigPath(config: unknown, pathStr: string): unknown {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (isBlockedObjectKey(part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function hasBlockedConfigPathSegment(pathStr: string): boolean {
  return pathStr
    .split(".")
    .filter(Boolean)
    .some((part) => isBlockedObjectKey(part));
}

/** Checks a config path with fallback defaults only when the path is unresolved. */
export function isConfigPathTruthyWithDefaults(
  config: unknown,
  pathStr: string,
  defaults: Record<string, boolean>,
): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (
    value === undefined &&
    !hasBlockedConfigPathSegment(pathStr) &&
    Object.hasOwn(defaults, pathStr)
  ) {
    return defaults[pathStr] ?? false;
  }
  return isTruthy(value);
}

type RuntimeRequires = {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
};

type RuntimeRequirementEvalParams = {
  requires?: RuntimeRequires;
  hasBin: (bin: string) => boolean;
  hasAnyRemoteBin?: (bins: string[]) => boolean;
  hasRemoteBin?: (bin: string) => boolean;
  hasEnv: (envName: string) => boolean;
  isConfigPathTruthy: (pathStr: string) => boolean;
};

/** Evaluates binary/env/config requirements against local and optional remote capabilities. */
function evaluateRuntimeRequires(params: RuntimeRequirementEvalParams): boolean {
  const requires = params.requires;
  if (!requires) {
    return true;
  }

  const requiredEnv = requires.env ?? [];
  if (requiredEnv.length > 0) {
    for (const envName of requiredEnv) {
      if (!params.hasEnv(envName)) {
        return false;
      }
    }
  }

  const requiredConfig = requires.config ?? [];
  if (requiredConfig.length > 0) {
    for (const configPath of requiredConfig) {
      if (!params.isConfigPathTruthy(configPath)) {
        return false;
      }
    }
  }

  const requiredBins = requires.bins ?? [];
  if (requiredBins.length > 0) {
    for (const bin of requiredBins) {
      if (params.hasBin(bin)) {
        continue;
      }
      if (params.hasRemoteBin?.(bin)) {
        continue;
      }
      return false;
    }
  }

  const requiredAnyBins = requires.anyBins ?? [];
  if (requiredAnyBins.length > 0) {
    const anyFound = requiredAnyBins.some((bin) => params.hasBin(bin));
    if (!anyFound && !params.hasAnyRemoteBin?.(requiredAnyBins)) {
      return false;
    }
  }

  return true;
}

/** Enforces OS compatibility before allowing `always` to bypass runtime requirements. */
export function evaluateRuntimeEligibility(
  params: {
    os?: string[];
    remotePlatforms?: string[];
    always?: boolean;
  } & RuntimeRequirementEvalParams,
): boolean {
  const osList = params.os ?? [];
  const remotePlatforms = params.remotePlatforms ?? [];
  if (
    osList.length > 0 &&
    !osList.includes(process.platform) &&
    !remotePlatforms.some((platform) => osList.includes(platform))
  ) {
    return false;
  }
  if (params.always === true) {
    return true;
  }
  return evaluateRuntimeRequires(params);
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

/** Checks PATH for an executable binary, including PATHEXT candidates on Windows. */
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
