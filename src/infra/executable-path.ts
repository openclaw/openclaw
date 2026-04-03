import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "./home-dir.js";

export type ExecutableResolutionMode = "host" | "virtual";

function isWindowsPlatform(platform?: string | null): boolean {
  return String(platform ?? process.platform)
    .trim()
    .toLowerCase()
    .startsWith("win");
}

function getPathModuleForPlatform(platform?: string | null): typeof path.posix {
  return isWindowsPlatform(platform) ? path.win32 : path.posix;
}

function getPathDelimiterForPlatform(platform?: string | null): string {
  return isWindowsPlatform(platform) ? ";" : ":";
}

export function isDriveLessWindowsRootedPath(value: string, platform?: string | null): boolean {
  return isWindowsPlatform(platform) && /^:[\\/]/.test(value);
}

export function resolveExecutablePathCandidate(
  rawExecutable: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    requirePathSeparator?: boolean;
    platform?: string | null;
    resolutionMode?: ExecutableResolutionMode;
  },
): string | undefined {
  const expanded = rawExecutable.startsWith("~")
    ? expandHomePrefix(rawExecutable, { env: options?.env })
    : rawExecutable;
  if (isDriveLessWindowsRootedPath(expanded, options?.platform)) {
    return undefined;
  }
  const hasPathSeparator = expanded.includes("/") || expanded.includes("\\");
  if (options?.requirePathSeparator && !hasPathSeparator) {
    return undefined;
  }
  if (!hasPathSeparator) {
    return expanded;
  }
  const targetPath = getPathModuleForPlatform(options?.platform);
  if (targetPath.isAbsolute(expanded)) {
    return targetPath.normalize(expanded);
  }
  const base = options?.cwd && options.cwd.trim() ? options.cwd.trim() : process.cwd();
  return targetPath.resolve(base, expanded);
}

function resolveVirtualExecutableFromPathHints(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  platform?: string | null,
): string | undefined {
  const candidates = resolveVirtualExecutablePathCandidates(executable, pathEnv, env, platform);
  return candidates[0];
}

export function resolveVirtualExecutablePathCandidates(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  platform?: string | null,
): string[] {
  const targetPath = getPathModuleForPlatform(platform);
  const entries = pathEnv
    .split(getPathDelimiterForPlatform(platform))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return [];
  }
  const extensions = resolveWindowsExecutableExtensions(executable, env, platform);
  const candidates: string[] = [];
  for (const entry of entries) {
    for (const ext of extensions) {
      candidates.push(targetPath.join(entry, executable + ext));
    }
  }
  return candidates;
}

function resolveWindowsExecutableExtensions(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  platform?: string | null,
): string[] {
  if (!isWindowsPlatform(platform)) {
    return [""];
  }
  if (path.extname(executable).length > 0) {
    return [""];
  }
  return [
    "",
    ...(
      env?.PATHEXT ??
      env?.Pathext ??
      process.env.PATHEXT ??
      process.env.Pathext ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => ext.toLowerCase()),
  ];
}

function resolveWindowsExecutableExtSet(
  env: NodeJS.ProcessEnv | undefined,
  platform?: string | null,
): Set<string> {
  if (!isWindowsPlatform(platform)) {
    return new Set<string>();
  }
  return new Set(
    (
      env?.PATHEXT ??
      env?.Pathext ??
      process.env.PATHEXT ??
      process.env.Pathext ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => ext.toLowerCase())
      .filter(Boolean),
  );
}

export function isExecutableFile(
  filePath: string,
  options?: { platform?: string | null; resolutionMode?: ExecutableResolutionMode },
): boolean {
  if (options?.resolutionMode === "virtual") {
    // Virtual resolution mode intentionally does not probe host filesystem state.
    return true;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (isWindowsPlatform(options?.platform)) {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) {
        return true;
      }
      return resolveWindowsExecutableExtSet(undefined, options?.platform).has(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: { platform?: string | null; resolutionMode?: ExecutableResolutionMode },
): string | undefined {
  if (options?.resolutionMode === "virtual") {
    return resolveVirtualExecutableFromPathHints(executable, pathEnv, env, options?.platform);
  }
  const targetPath = getPathModuleForPlatform(options?.platform);
  const entries = pathEnv
    .split(getPathDelimiterForPlatform(options?.platform))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(executable, env, options?.platform);
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = targetPath.join(entry, executable + ext);
      if (isExecutableFile(candidate, options)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveExecutablePath(
  rawExecutable: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
    resolutionMode?: ExecutableResolutionMode;
  },
): string | undefined {
  const resolutionMode = options?.resolutionMode ?? "host";
  const candidate = resolveExecutablePathCandidate(rawExecutable, options);
  if (!candidate) {
    return undefined;
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    if (resolutionMode === "virtual") {
      return candidate;
    }
    return isExecutableFile(candidate, options) ? candidate : undefined;
  }
  const envPath =
    options?.env?.PATH ?? options?.env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  return resolveExecutableFromPathEnv(candidate, envPath, options?.env, options);
}
