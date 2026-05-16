import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createCommandWorkspaceHarness(prefix: string) {
  const tempDirs: string[] = [];

  return {
    async createWorkspace(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    async cleanupWorkspaces() {
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
  };
}
