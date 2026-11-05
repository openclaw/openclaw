import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveServiceTmpDir } from "../daemon/service-tmp-dir.js";

let darwinUserTempDir: string | undefined;

function samePath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  return path.resolve(left) === path.resolve(right) || canonical(left) === canonical(right);
}

// launchd gives a macOS Gateway its state's TMPDIR, unlike terminals and other
// profiles. Map that managed TMPDIR back to the OS per-user root they all share.
export function resolveManagedUpdateLeaseTempRoot(): string {
  const tmp = os.tmpdir();
  if (
    process.platform !== "darwin" ||
    !samePath(tmp, resolveServiceTmpDir(process.env, "darwin"))
  ) {
    return tmp;
  }
  if (darwinUserTempDir === undefined) {
    try {
      const value = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      if (path.isAbsolute(value)) {
        darwinUserTempDir = path.resolve(value);
      }
    } catch {
      // Keep the caller's temp root when the OS value is unavailable.
    }
  }
  return darwinUserTempDir ?? tmp;
}
