import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "./home-dir.js";

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
  return (
    env?.PATHEXT ??
    env?.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM"
  )
    .split(";")
    .map((ext) => ext.toLowerCase());
}

export function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
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
      if (isExecutableFile(candidate)) {
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
  const expanded = rawExecutable.startsWith("~") ? expandHomePrefix(rawExecutable) : rawExecutable;
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) {
      return isExecutableFile(expanded) ? expanded : undefined;
    }
    const base = options?.cwd && options.cwd.trim() ? options.cwd.trim() : process.cwd();
    const candidate = path.resolve(base, expanded);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  const envPath =
    options?.env?.PATH ?? options?.env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  return resolveExecutableFromPathEnv(expanded, envPath, options?.env);
}
