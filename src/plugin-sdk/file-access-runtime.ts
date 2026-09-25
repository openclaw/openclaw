// Safe local-file helpers for plugin runtime media and bridge code.
import { removePathWithinRoot as removePathWithinRootCore } from "../infra/fs-safe-remove.js";
import { statRegularFileSync as inspectRegularFileSync } from "../infra/fs-safe.js";

/** Return whether a path resolves to a regular file, treating filesystem errors as missing. */
export function fileExists(filePath: string): boolean {
  try {
    return !inspectRegularFileSync(filePath).missing;
  } catch {
    return false;
  }
}

export {
  canonicalPathFromExistingAncestor,
  readFileWithinRoot,
  readLocalFileFromRoots,
  readRegularFile,
  readRegularFileSync,
  readSecureFile,
  root,
  statRegularFile,
  statRegularFileSync,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  readFileHandleBounded,
  resolvePathPrefixSync,
  tempFile,
} from "../infra/fs-safe-advanced.js";
export { readFileWindowFully } from "../infra/file-read.js";
export { inspectPathPermissions } from "../infra/permissions.js";
export { writeFileWindowFully } from "../infra/file-descriptor.js";
export { openRootFile } from "../infra/boundary-file-read.js";
export {
  ensureDurableDirectory,
  sha256File,
  syncDirectory,
  type DirectorySyncOutcome,
} from "../infra/directory-durability.js";
// Keep updater controls outside this facade's existing contract.
export const removePathWithinRoot: (params: {
  rootDir: string;
  relativePath: string;
  recursive?: boolean;
  force?: boolean;
}) => Promise<void> = removePathWithinRootCore;
export { basenameFromMediaSource, safeFileURLToPath } from "../infra/local-file-access.js";
export { isPathInside, isPathStrictlyInside } from "../infra/path-guards.js";
export { getFileWatchCapacityCode } from "../infra/fs-watch-errors.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { readFileRangeAsync } from "../config/sessions/file-range.js";
