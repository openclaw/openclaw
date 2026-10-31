import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";
import { createStateDatabaseFixture, withBackupStateEnv } from "./git-backup.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
let nativeConfig: ReturnType<typeof getFsSafeNativeConfig>;
beforeEach(() => {
  nativeConfig = getFsSafeNativeConfig();
  configureFsSafeNative({ mode: "off" });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative(nativeConfig);
});

it.each([
  { operation: "create", failure: true, cleanup: "remove", workspace: "backup" },
  { operation: "create", failure: false, cleanup: "remove", workspace: "backup-index" },
  { operation: "verify", failure: false, cleanup: "rename", workspace: "verify" },
  { operation: "restore", failure: false, cleanup: "remove", workspace: "codec" },
  { operation: "restore", failure: true, cleanup: "remove", workspace: "codec" },
] as const)(
  "reports $operation $workspace cleanup $cleanup failures without replacing its primary outcome (failure=$failure)",
  async ({ operation, failure, cleanup, workspace }) => {
    const root = roots.make("openclaw-git-backup-test-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    const targetPath = path.join(root, "restored.sqlite");
    const backup = { repositoryPath, stateDir, databases: [database] };
    const scope = { repositoryPath, identity: database.identity, targetPath };
    const run = {
      create: () => createGitBackup(backup),
      verify: () => verifyGitBackupRef(scope),
      restore: () => restoreGitBackupRef(scope),
    };
    const primary = new Error("synthetic backup I/O failure");
    const removal = Object.assign(new Error("EACCES: synthetic private cleanup failure"), {
      code: "EACCES",
    });
    const retained = new Set<string>();
    const prefix = workspace === "codec" ? ".git-backup-restore-" : `openclaw-git-${workspace}-`;
    const rename = fsSync.renameSync;
    const { rm, rmdir, open } = fs;
    const codec = workspace === "codec";
    const basename = (value: unknown) => path.basename(String(value));
    await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      if (operation !== "create") {
        await createGitBackup(backup);
      }
      const warning = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
        const name = basename(source);
        const selected =
          name.startsWith(prefix) &&
          (workspace === "backup-index" || !name.startsWith("openclaw-git-backup-index-"));
        if (selected && cleanup === "rename") {
          retained.add(String(source));
          throw removal;
        }
        rename(source, destination);
        if (selected) {
          retained.add(String(destination));
        }
      });
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (codec && basename(args[0]).startsWith(prefix)) {
          retained.add(String(args[0]));
          throw removal;
        }
        if (retained.has(String(args[0]))) {
          throw removal;
        }
        if (failure && operation === "create" && basename(args[0]) === "global-0.sqlite") {
          throw primary;
        }
        return await rm(...args);
      });
      vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        if (retained.has(String(args[0]))) {
          throw removal;
        }
        return await rmdir(...args);
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (failure && codec && String(args[0]).includes(`${path.sep}.git-backup-restore-`)) {
          throw primary;
        }
        return await open(...args);
      });
      try {
        const running = run[operation]();
        if (failure) {
          await expect(running).rejects.toBe(primary);
        } else {
          await running;
        }
        const diagnostics = warning.mock.calls.flat().join("\n");
        expect(diagnostics).toMatch(
          /Warning: Git backup temporary files may remain under .*; cleanup failed:/u,
        );
        if (!codec) {
          expect(diagnostics).toContain(cleanup === "rename" ? "indeterminate" : "EACCES");
        }
        expect(retained.size).toBeGreaterThan(0);
        for (const retainedPath of retained) {
          expect((await fs.lstat(retainedPath)).isDirectory()).toBe(true);
          if (codec) {
            expect(diagnostics).toContain(retainedPath);
          }
        }
        if (codec) {
          if (failure) {
            await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect((await fs.lstat(targetPath)).isFile()).toBe(true);
          }
        }
      } finally {
        vi.restoreAllMocks();
        for (const retainedPath of retained) {
          await rm(retainedPath, { recursive: true, force: true });
        }
      }
    });
  },
);
