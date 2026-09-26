import fs from "node:fs/promises";
import path from "node:path";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { statOrMissing } from "./update-recovery-backup-files.js";

export async function writeUpdateRecoveryPrivacyMarker(directory: string): Promise<void> {
  const marker = path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER);
  const existing = await statOrMissing(marker);
  if (existing) {
    if (
      !existing.isFile() ||
      existing.size !== Buffer.byteLength(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT) ||
      (process.platform !== "win32" && (existing.mode & 0o077) !== 0)
    ) {
      throw new Error(`Invalid private update capture marker: ${marker}`);
    }
    const source = await (
      await safeRoot(directory)
    ).open(UPDATE_CAPTURE_PRIVACY_MARKER, {
      symlinks: "reject",
      hardlinks: "reject",
    });
    try {
      if ((await source.handle.readFile("utf8")) !== UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT) {
        throw new Error(`Invalid private update capture marker: ${marker}`);
      }
    } finally {
      await source.handle.close();
    }
  } else {
    const output = await fs.open(marker, "wx", 0o600);
    try {
      await output.writeFile(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);
      await output.sync();
    } finally {
      await output.close();
    }
  }
  requireDirectorySync(await syncDirectory(directory), "Update capture privacy marker");
}
