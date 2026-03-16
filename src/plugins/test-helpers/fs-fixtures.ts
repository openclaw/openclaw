import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

export function mkdirSafeDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

export function makeTrackedTempDir(prefix: string, trackedDirs: string[]) {
  const dir = path.join(resolvePreferredOpenClawTmpDir(), `${prefix}-${randomUUID()}`);
  mkdirSafeDir(dir);
  trackedDirs.push(dir);
  return dir;
}

export function cleanupTrackedTempDirs(trackedDirs: string[]) {
  for (const dir of trackedDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}
