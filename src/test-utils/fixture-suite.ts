import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createFixtureSuite(rootPrefix: string) {
  let fixtureRoot = "";
  let fixtureCount = 0;

  return {
    async setup(): Promise<void> {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), rootPrefix));
    },
    async cleanup(): Promise<void> {
      if (!fixtureRoot) {
        return;
      }
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    },
    async createCaseDir(prefix: string): Promise<string> {
      if (!fixtureRoot) {
        throw new Error("Fixture suite not initialized");
      }
      const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}
