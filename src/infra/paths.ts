import path from "node:path";

/**
 * Validates that a resolved path stays within a base directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 *
 * Returns true for entries that resolve exactly to the base directory (e.g., tar "./" root
 * entries) as well as entries within it. Returns false for the empty string.
 */
export function isPathWithinBase(baseDir: string, targetPath: string): boolean {
  // Explicitly reject empty paths — they are not valid archive entries.
  if (targetPath === "") return false;

  if (process.platform === "win32") {
    const normalizedBase = path.win32.normalize(path.win32.resolve(baseDir));
    const normalizedTarget = path.win32.normalize(path.win32.resolve(normalizedBase, targetPath));

    // Windows paths are typically case-insensitive.
    const rel = path.win32.relative(normalizedBase.toLowerCase(), normalizedTarget.toLowerCase());
    // rel === "" means the entry resolves exactly to the base dir (allowed, e.g. "./" root entries).
    return !rel.startsWith("..") && !path.win32.isAbsolute(rel);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  // rel === "" means the entry resolves exactly to the base dir (allowed, e.g. "./" root entries).
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
