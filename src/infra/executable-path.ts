import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "./home-dir.js";

const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

function getWindowsExecutableExtensions(env: NodeJS.ProcessEnv | undefined): string[] {
  const raw =
    env?.PATHEXT ??
    env?.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS.join(";");
  const extensions = raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS;
}

function resolveWindowsExecutableExtensions(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  if (path.extname(executable).length > 0) {
    return [""];
  }
  return getWindowsExecutableExtensions(env);
}

export function isExecutableFile(filePath: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return getWindowsExecutableExtensions(env).includes(path.extname(filePath).toLowerCase());
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
): string | undefined {
  const entries = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(executable, env);
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, executable + ext);
      if (isExecutableFile(candidate, env)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveExecutablePath(
  rawExecutable: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): string | undefined {
  const expanded = rawExecutable.startsWith("~")
    ? expandHomePrefix(rawExecutable, { env: options?.env })
    : rawExecutable;
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) {
      return isExecutableFile(expanded, options?.env) ? expanded : undefined;
    }
    const base = options?.cwd && options.cwd.trim() ? options.cwd.trim() : process.cwd();
    const candidate = path.resolve(base, expanded);
    return isExecutableFile(candidate, options?.env) ? candidate : undefined;
  }
  const envPath =
    options?.env?.PATH ?? options?.env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  return resolveExecutableFromPathEnv(expanded, envPath, options?.env);
}
