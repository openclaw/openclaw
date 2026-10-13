import { hasNodeErrorCode as hasErrnoCode } from "@openclaw/fs-safe/path";
export { isNodeError as isErrno } from "@openclaw/fs-safe/path";
export { hasErrnoCode };

/** Classifies missing filesystem paths across Node and fs-safe boundaries. */
export function isMissingPathError(err: unknown): boolean {
  return (
    hasErrnoCode(err, "ENOENT") || hasErrnoCode(err, "ENOTDIR") || hasErrnoCode(err, "not-found")
  );
}
