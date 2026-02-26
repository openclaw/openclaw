import path from "node:path";

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);

function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith("UNC\\")) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalized.replaceAll("/", "\\").toLowerCase();
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(
    value && typeof value === "object" && "code" in (value as Record<string, unknown>),
  );
}

export function hasNodeErrorCode(value: unknown, code: string): boolean {
  return isNodeError(value) && value.code === code;
}

export function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}

export function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}

export function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (process.platform === "win32") {
    const rootForCompare = normalizeWindowsPathForComparison(resolvedRoot);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedTarget);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
