// Renames staged private SQLite snapshot files into their published names.
import fs from "node:fs";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "./errno.js";

/** Rename a fully written private snapshot file into place. Windows profile
 * directories encrypted with EFS refuse same-directory renames with a false
 * cross-device error even though the move never crosses a device; copy the
 * staged bytes instead so publication cannot abort on such filesystems. */
export function renameStagedSnapshotFile(stagedPath: string, publishedPath: string): void {
  try {
    fs.renameSync(stagedPath, publishedPath);
    return;
  } catch (error) {
    if (!hasErrnoCode(error, "EXDEV")) {
      throw error;
    }
  }
  fs.rmSync(publishedPath, { force: true });
  const source = fs.openSync(stagedPath, "r");
  try {
    const target = fs.openSync(publishedPath, "wx", 0o600);
    try {
      copyFileDescriptorSync(source, target);
      fs.fsyncSync(target);
    } finally {
      fs.closeSync(target);
    }
  } finally {
    fs.closeSync(source);
  }
  fs.rmSync(stagedPath, { force: true });
}
