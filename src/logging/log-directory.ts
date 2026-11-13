import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";

/**
 * Creates a log directory and its missing parents with a bounded number of mkdir calls.
 * Node's recursive mkdirSync retries forever when a parent exists but refuses new
 * children (a deleted directory that is still mounted, such as a stale systemd
 * PrivateTmp), which would block the event loop inside the logger.
 */
export function ensureLogDirectorySync(dir: string, createParents = true, mode = 0o777): void {
  try {
    fs.mkdirSync(dir, { mode });
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "EEXIST" && fs.statSync(dir).isDirectory()) {
      return;
    }
    const parent = path.dirname(dir);
    if (!createParents || code !== "ENOENT" || parent === dir) {
      throw error;
    }
    ensureLogDirectorySync(parent, true, mode);
    // One retry once the parents exist; a second ENOENT is final.
    ensureLogDirectorySync(dir, false, mode);
  }
}
