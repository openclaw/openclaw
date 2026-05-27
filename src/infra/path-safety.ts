import path from "node:path";
import { isPathInside } from "./path-guards.js";

export function resolveSafeBaseDir(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

export function isWithinDir(rootDir: string, targetPath: string): boolean {
  return isPathInside(rootDir, targetPath);
}
