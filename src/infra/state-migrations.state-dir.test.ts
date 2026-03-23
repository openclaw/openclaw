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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-state-dir-"));
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

describe("legacy state dir auto-migration", () => {
  it("follows legacy symlink when it points at another legacy dir (clawdbot -> moltbot)", async () => {
    const root = await makeTempRoot();
    const legacySymlink = path.join(root, ".clawdbot");
    const legacyDir = path.join(root, ".moltbot");

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

    const dirLinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

    const result = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.migrated).toBe(true);
    expect(result.warnings).toEqual([]);

    const targetMarker = path.join(root, ".openclaw", "marker.txt");
    expect(fs.readFileSync(targetMarker, "utf-8")).toBe("ok");
    expect(fs.readFileSync(path.join(root, ".moltbot", "marker.txt"), "utf-8")).toBe("ok");
    expect(fs.readFileSync(path.join(root, ".clawdbot", "marker.txt"), "utf-8")).toBe("ok");
  });
});
