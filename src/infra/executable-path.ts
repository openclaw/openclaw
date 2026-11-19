// Resolves executable paths from PATH and platform-specific install locations.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { expandHomePrefix } from "./home-dir.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { resolveEnvironmentValue } from "./process-env.js";

export function resolveExecutablePathCandidate(
  rawExecutable: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; requirePathSeparator?: boolean },
): string | undefined {
  const expanded = rawExecutable.startsWith("~")
    ? expandHomePrefix(rawExecutable, { env: options?.env })
    : rawExecutable;
  if (process.platform === "win32" && /^:[\\/]/.test(expanded)) {
    return undefined;
  }
  const hasPathSeparator = expanded.includes("/") || expanded.includes("\\");
  if (options?.requirePathSeparator && !hasPathSeparator) {
    return undefined;
  }
  if (!hasPathSeparator) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  const base = options?.cwd && options.cwd.trim() ? options.cwd : process.cwd();
  return path.resolve(base, expanded);
}

function resolveWindowsExecutableExtensions(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  includeExtensionless = true,
): string[] {
  if (process.platform !== "win32" || path.extname(executable).length > 0) {
    return [""];
  }
  const extensions = [...resolveWindowsExecutableExtSet(env)];
  return includeExtensionless ? ["", ...extensions] : extensions;
}

function resolveWindowsExecutableExtSet(env: NodeJS.ProcessEnv | undefined): Set<string> {
  return new Set(
    (
      resolveEnvironmentValue(env, "PATHEXT") ??
      resolveEnvironmentValue(process.env, "PATHEXT") ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      .filter(Boolean),
  );
}

export function isRegularFile(filePath: string): boolean {
  return safeStatSync(filePath)?.isFile() ?? false;
}

const WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);

function isWindowsExecutable(filePath: string, env?: NodeJS.ProcessEnv): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  // PATHEXT controls suffix probing, not an explicitly named native file.
  return (
    !ext ||
    WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(ext) ||
    resolveWindowsExecutableExtSet(env).has(ext)
  );
}

export async function isExecutableFileAsync(
  filePath: string,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  try {
    if (!(await fsp.stat(filePath)).isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return isWindowsExecutable(filePath, options?.env);
    }
    await fsp.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Checks a supplied path without PATH lookup or lexical normalization. */
export function isExecutableFile(filePath: string, options?: { env?: NodeJS.ProcessEnv }): boolean {
  if (!isRegularFile(filePath)) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      return isWindowsExecutable(filePath, options?.env);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const EXECUTABLE_PATH_CACHE_TTL_MS = 60_000;
const EXECUTABLE_PATH_CACHE_MAX_ENTRIES = 128;

type ExecutablePathCacheEntry = {
  expiresAt: number;
  resolved: string | null;
};

let executablePathCache = new Map<string, ExecutablePathCacheEntry>();

function cacheExecutablePath(
  cache: Map<string, ExecutablePathCacheEntry>,
  key: string,
  resolved: string | undefined,
): void {
  cache.set(key, {
    expiresAt: Date.now() + EXECUTABLE_PATH_CACHE_TTL_MS,
    resolved: resolved ?? null,
  });
  pruneMapToMaxSize(cache, EXECUTABLE_PATH_CACHE_MAX_ENTRIES);
}

/** Clears process-local PATH probe results after the runtime environment changes. */
export function clearExecutablePathCache(): void {
  // Retire pending async probes too: they can only populate their original map.
  executablePathCache = new Map();
}

/** Prepared entries preserve delimiters introduced by caller-owned home expansion. */
function* executablePathProbes(
  executable: string,
  pathEnv: string | readonly string[],
  env?: NodeJS.ProcessEnv,
  options?: { includeExtensionless?: boolean; cwd?: string; useCache?: boolean },
): Generator<string, string | undefined, boolean> {
  const cache = executablePathCache;
  const cwd = options?.cwd?.trim() ? path.resolve(options.cwd) : undefined;
  const useCache = options?.useCache !== false;
  const pathExt =
    resolveEnvironmentValue(env, "PATHEXT") ??
    resolveEnvironmentValue(process.env, "PATHEXT") ??
    "";
  let cacheCwd = "";
  try {
    // Relative PATH entries resolve against cwd, so changing directories must invalidate them.
    cacheCwd = cwd ?? process.cwd();
  } catch {
    // A deleted cwd already makes relative probes fail; keep the cache key stable for that state.
  }
  const cacheKey = `${process.platform}\0${executable}\0${JSON.stringify(pathEnv)}\0${pathExt}\0${options?.includeExtensionless !== false}\0${cacheCwd}\0${cwd !== undefined}`;
  const cached = useCache ? cache.get(cacheKey) : undefined;
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    // Hits and misses remain valid while the same PATH/PATHEXT/cwd key is used; config reload clears
    // the map. Installs/removals under an unchanged key intentionally need reload or a 60s idle gap,
    // because steady pollers must never fall back into synchronous PATH stat loops.
    cached.expiresAt = now + EXECUTABLE_PATH_CACHE_TTL_MS;
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.resolved ?? undefined;
  }
  if (cached) {
    cache.delete(cacheKey);
  }
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const entries = (typeof pathEnv === "string" ? pathEnv.split(delimiter) : pathEnv).filter(
    (entry) => Boolean(entry) || (cwd !== undefined && process.platform !== "win32"),
  );
  const extensions = resolveWindowsExecutableExtensions(
    executable,
    env,
    options?.includeExtensionless,
  );
  for (const entry of entries) {
    const hasParentTraversal = process.platform !== "win32" && entry.split("/").includes("..");
    const rawDirectory =
      cwd !== undefined && !path.isAbsolute(entry) ? `${cwd}${path.sep}${entry}` : entry;
    for (const ext of extensions) {
      // Folding ".." can replace the filesystem parent of a symlink with a different directory.
      const candidate = hasParentTraversal
        ? `${rawDirectory}${path.sep}${executable}${ext}`
        : path.join(cwd === undefined ? entry : path.resolve(cwd, entry), executable + ext);
      if (yield candidate) {
        if (useCache) {
          cacheExecutablePath(cache, cacheKey, candidate);
        }
        return candidate;
      }
    }
  }
  if (useCache) {
    cacheExecutablePath(cache, cacheKey, undefined);
  }
  return undefined;
}

// The synchronous adapter preserves the public node-host SDK contract and CLI callers.
// Runtime command preparation uses the async adapter over the same search policy.
export function resolveExecutableFromPathEnv(
  ...args: Parameters<typeof executablePathProbes>
): string | undefined {
  const probes = executablePathProbes(...args);
  let next = probes.next();
  while (!next.done) {
    next = probes.next(isExecutableFile(next.value, { env: args[2] }));
  }
  return next.value;
}

export async function resolveExecutableFromPathEnvAsync(
  ...args: Parameters<typeof executablePathProbes>
): Promise<string | undefined> {
  const probes = executablePathProbes(...args);
  let next = probes.next();
  while (!next.done) {
    next = probes.next(await isExecutableFileAsync(next.value, { env: args[2] }));
  }
  return next.value;
}

function* executableCandidateProbes(
  rawExecutable: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; useCache?: boolean },
): Generator<string, string | undefined, boolean> {
  const candidate = resolveExecutablePathCandidate(rawExecutable, options);
  if (!candidate) {
    return undefined;
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    return (yield candidate) ? candidate : undefined;
  }
  const envPath =
    resolveEnvironmentValue(options?.env, "PATH") ??
    resolveEnvironmentValue(process.env, "PATH") ??
    "";
  return yield* executablePathProbes(candidate, envPath, options?.env, {
    cwd: options?.cwd,
    useCache: options?.useCache,
  });
}

export function resolveExecutablePath(
  ...args: Parameters<typeof executableCandidateProbes>
): string | undefined {
  const probes = executableCandidateProbes(...args);
  let next = probes.next();
  while (!next.done) {
    next = probes.next(isExecutableFile(next.value, args[1]));
  }
  return next.value;
}

export async function resolveExecutablePathAsync(
  ...args: Parameters<typeof executableCandidateProbes>
): Promise<string | undefined> {
  const probes = executableCandidateProbes(...args);
  let next = probes.next();
  while (!next.done) {
    next = probes.next(await isExecutableFileAsync(next.value, args[1]));
  }
  return next.value;
}

/**
 * On Windows, resolves a bare command name to its full .cmd or .exe path by
 * probing PATH/PATHEXT without executing another resolver. On non-Windows this
 * is a no-op.
 */
export function resolveExecutable(cmd: string): string {
  if (process.platform !== "win32") {
    return cmd;
  }
  if (
    WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(cmd)))
  ) {
    return cmd;
  }

  const envPath = resolveEnvironmentValue(process.env, "PATH") ?? "";
  const entries = envPath.split(";").filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(cmd, process.env);
  const matches: string[] = [];
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, cmd + ext);
      if (isExecutableFile(candidate, { env: process.env })) {
        matches.push(candidate);
      }
    }
  }

  return (
    matches.find((match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".cmd") ??
    matches.find((match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".exe") ??
    matches[0] ??
    cmd
  );
}
