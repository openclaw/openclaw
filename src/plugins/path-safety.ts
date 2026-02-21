import fs from "node:fs";
import path from "node:path";

export function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(baseDir, targetPath);
  if (!rel) {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null {
  const cached = cache?.get(targetPath);
  if (cached) {
    return cached;
  }
  try {
    const resolved = fs.realpathSync(targetPath);
    cache?.set(targetPath, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export function safeStatSync(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

export function formatPosixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}
