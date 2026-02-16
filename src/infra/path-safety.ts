import path from "node:path";

export function resolveSafeBaseDir(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

export function isWithinDir(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  // Windows paths are effectively case-insensitive; normalize to avoid false negatives.
  if (process.platform === "win32") {
    const relative = path.win32.relative(resolvedRoot.toLowerCase(), resolvedTarget.toLowerCase());
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
