import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return params.command;
  }
  const basename = normalizeLowercaseStringOrEmpty(path.basename(params.command));
  if (path.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    return `${params.command}.cmd`;
  }
  return params.command;
}

export function resolveWindowsPathEnv(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env;
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase() === "PATH" && typeof value === "string") {
      return value;
    }
  }
  return "";
}

function findCmdShimOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function hasExeOnPath(baseName: string, pathEnv: string): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    if (fs.existsSync(path.join(dir, `${baseName}.exe`))) {
      return true;
    }
  }
  return false;
}

export function resolveWindowsCmdShimArgv(
  argv: readonly string[],
  options?: { platform?: NodeJS.Platform; pathEnv?: string },
): string[] {
  const result = [...argv];
  if ((options?.platform ?? process.platform) !== "win32") {
    return result;
  }
  const first = result[0];
  if (!first) {
    return result;
  }
  const hasSeparator = first.includes("\\") || first.includes("/");
  const ext = normalizeLowercaseStringOrEmpty(path.extname(first));
  let shimPath: string;
  if (ext === ".cmd") {
    if (hasSeparator) {
      shimPath = first;
    } else {
      const resolved = findCmdShimOnPath(first, options?.pathEnv ?? process.env.PATH ?? "");
      if (!resolved) {
        return result;
      }
      shimPath = resolved;
    }
  } else if (!ext && !hasSeparator) {
    const pathEnvValue = options?.pathEnv ?? process.env.PATH ?? "";
    if (hasExeOnPath(first, pathEnvValue)) {
      return result;
    }
    const resolved = findCmdShimOnPath(`${first}.cmd`, pathEnvValue);
    if (!resolved) {
      return result;
    }
    shimPath = resolved;
  } else {
    return result;
  }
  let shimContent: string;
  try {
    shimContent = fs.readFileSync(shimPath, "utf8");
  } catch {
    return result;
  }
  const match = shimContent.match(/"%(?:~?dp0)%\\?([^"]+\.(?:exe|js))"\s+%\*/i);
  if (!match) {
    return result;
  }
  const target = path.join(path.dirname(shimPath), match[1]);
  if (!fs.existsSync(target)) {
    return result;
  }
  if (normalizeLowercaseStringOrEmpty(path.extname(target)) === ".js") {
    return [process.execPath, target, ...result.slice(1)];
  }
  result[0] = target;
  return result;
}
