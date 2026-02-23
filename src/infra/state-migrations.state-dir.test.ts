import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.js";

let tempRoot: string | null = null;

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bot-state-dir-"));
  tempRoot = root;
  return root;
}

afterEach(async () => {
  resetAutoMigrateLegacyStateDirForTest();
  if (!tempRoot) {
    return;
  }
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("state dir auto-migration", () => {
  it("skips migration when state dir already exists", async () => {
    const root = await makeTempRoot();
    const botDir = path.join(root, ".bot");

    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, "marker.txt"), "ok", "utf-8");

    const result = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(path.join(root, ".bot", "marker.txt"), "utf-8")).toBe("ok");
  });
});
