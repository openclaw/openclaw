import os from "node:os";
import path from "node:path";
import { resolveHomeRelativePath } from "../infra/home-dir.js";

export function resolveMigrationUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveHomeRelativePath(input, { env, homedir: os.homedir });
}

export function normalizeMigrationPath(input: string): string {
  return path.resolve(input);
}

export function safeRelativeArchivePath(sourceDir: string, sourcePath: string): string {
  const relative = path.relative(sourceDir, sourcePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(sourcePath);
  }
  return relative;
}

export function timestampForPath(date = new Date()): string {
  return date.toISOString().replaceAll(":", "-");
}
