// Generates tiny plugin fixtures for plugin loader tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export const pluginTestRepoRoot = path.resolve(import.meta.dirname, "../..");

const tempDirs: string[] = [];

export function createGeneratedPluginTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  return tempRoot;
}

export function installGeneratedPluginTempRootCleanup() {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
