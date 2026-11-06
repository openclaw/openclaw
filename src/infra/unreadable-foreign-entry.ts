import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { hasErrnoCode, isErrno } from "./errno.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "./update-capture-privacy-marker.js";

/** Permission failures may omit foreign data, never the invoking user's originals. */
export function isUnreadableForeignEntry(error: unknown, sourcePath: string): boolean {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    return false;
  }
  const permission = collectErrorGraphCandidates(error, (candidate) => [candidate.cause])
    .filter(isErrno)
    .find((candidate) => hasErrnoCode(candidate, "EACCES") || hasErrnoCode(candidate, "EPERM"));
  if (!permission || path.basename(sourcePath) === UPDATE_CAPTURE_PRIVACY_MARKER) {
    return false;
  }
  // A present marker must still be validated. Only a directory we cannot search
  // may be omitted before its marker is inspected; unreadable marker bytes refuse.
  if (
    "path" in permission &&
    typeof permission.path === "string" &&
    path.basename(permission.path) === UPDATE_CAPTURE_PRIVACY_MARKER
  ) {
    try {
      fs.lstatSync(permission.path);
      return false;
    } catch (markerError) {
      if (!hasErrnoCode(markerError, "EACCES") && !hasErrnoCode(markerError, "EPERM")) {
        return false;
      }
    }
  }
  const failedPath =
    "path" in permission && typeof permission.path === "string"
      ? path.resolve(permission.path)
      : path.resolve(sourcePath);
  if (!isPathInside(path.resolve(sourcePath), failedPath)) {
    return false;
  }
  let candidate = failedPath;
  for (;;) {
    try {
      const stat = fs.lstatSync(candidate);
      return stat.uid !== uid && (candidate === failedPath || stat.isDirectory());
    } catch (statError) {
      if (!hasErrnoCode(statError, "EACCES") && !hasErrnoCode(statError, "EPERM")) {
        return false;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return false;
    }
    candidate = parent;
  }
}

export function formatUnreadableForeignEntryWarning(sourcePath: string): string {
  return `Skipped unreadable foreign entry: ${sourcePath}`;
}
