import { realpathSync } from "node:fs";
import { relative, resolve as resolvePath, sep } from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";

/** Preserve the supplied spelling when the path cannot be resolved. */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
  const resolvedCwd = resolvePath(cwd);
  const resolvedPath = resolvePath(resolvedCwd, filePath);
  const relativePath = relative(resolvedCwd, resolvedPath);
  return (isPathRelativeEscape(relativePath) ? resolvedPath : relativePath || ".")
    .split(sep)
    .join("/");
}
