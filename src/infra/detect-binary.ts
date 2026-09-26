// Detects safe executable names or paths without shell evaluation.
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { isSafeExecutableValue } from "./exec-safety.js";
import { isExecutableFile, resolveExecutableFromPathEnv } from "./executable-path.js";
import { resolveEnvironmentValue } from "./process-env.js";

// Binary detection accepts safe executable names or explicit paths and avoids
// shell evaluation when probing PATH.
/** Return true when a safe executable name/path can be found on this host. */
export async function detectBinary(name: string): Promise<boolean> {
  if (!name?.trim()) {
    return false;
  }
  if (!isSafeExecutableValue(name)) {
    return false;
  }
  const resolved = name.startsWith("~") ? resolveUserPath(name) : name;
  if (
    path.isAbsolute(resolved) ||
    resolved.startsWith(".") ||
    resolved.includes("/") ||
    resolved.includes("\\")
  ) {
    // Callers execute this path as supplied. Let the filesystem resolve symlink/..
    // and trailing separators instead of changing their meaning with path.resolve.
    return isExecutableFile(resolved);
  }

  try {
    const cwd = process.cwd();
    const pathEnv = resolveEnvironmentValue(process.env, "PATH") ?? "";
    // where.exe also searches cwd; POSIX which treats empty PATH entries as cwd.
    const searchPath = process.platform === "win32" ? `${cwd};${pathEnv}` : pathEnv;
    // where.exe accepts an explicit suffix even when PATHEXT does not list it.
    const extension = process.platform === "win32" ? path.extname(name) : "";
    const lookupEnv = extension ? { PATHEXT: extension } : process.env;
    return Boolean(
      resolveExecutableFromPathEnv(name, searchPath, lookupEnv, { cwd, useCache: false }),
    );
  } catch {
    return false;
  }
}
