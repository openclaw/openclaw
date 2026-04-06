import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, type RmOptions } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function createPluginSdkTestHarness(options?: { cleanup?: RmOptions }) {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, {
        recursive: true,
        force: true,
        ...options?.cleanup,
      });
    }
  });

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createTempDirSync(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  return {
    createTempDir,
    createTempDirSync,
  };
}
