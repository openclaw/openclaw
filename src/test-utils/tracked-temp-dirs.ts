import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createTrackedTempDirs() {
  const dirs: string[] = [];

  return {
    async make(prefix: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    async cleanup(): Promise<void> {
      await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    },
  };
}
