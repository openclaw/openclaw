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
  it("skips a legacy symlinked state dir when it points outside supported legacy roots", async () => {
    const root = await makeTempRoot();
    const legacySymlink = path.join(root, ".clawdbot");
    const legacyDir = path.join(root, "legacy-state-source");

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

    const dirLinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

    const result = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result.migrated).toBe(false);
    expect(result.warnings).toEqual([
      `Legacy state dir is a symlink (${legacySymlink} → ${legacyDir}); skipping auto-migration.`,
    ]);
    expect(fs.readFileSync(path.join(root, "legacy-state-source", "marker.txt"), "utf-8")).toBe(
      "ok",
    );
    expect(fs.readFileSync(path.join(root, ".clawdbot", "marker.txt"), "utf-8")).toBe("ok");
  });

  it("skips state-dir migration when OPENCLAW_STATE_DIR is explicitly set", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, ".clawdbot");
    fs.mkdirSync(legacyDir, { recursive: true });

    const result = await autoMigrateLegacyStateDir({
      env: { OPENCLAW_STATE_DIR: path.join(root, "custom-state") } as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(result).toEqual({
      migrated: false,
      skipped: true,
      changes: [],
      warnings: [],
    });
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it("only runs once per process until reset", async () => {
    const root = await makeTempRoot();
    const legacyDir = path.join(root, ".clawdbot");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

    const first = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });
    const second = await autoMigrateLegacyStateDir({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => root,
    });

    expect(first.migrated).toBe(true);
    expect(second).toEqual({
      migrated: false,
      skipped: true,
      changes: [],
      warnings: [],
    });
  });
});
