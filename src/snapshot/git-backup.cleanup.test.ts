import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";
import { createStateDatabaseFixture, withBackupStateEnv } from "./git-backup.test-support.js";

const roots = createTempDirTracker();
const tempRoot = () => roots.make("openclaw-git-backup-test-");

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  roots.cleanup();
});

it.each([
  { operation: "create", failure: false, cleanup: "remove", workspace: "backup" },
  { operation: "create", failure: true, cleanup: "remove", workspace: "backup" },
  { operation: "create", failure: false, cleanup: "remove", workspace: "backup-index" },
  { operation: "verify", failure: false, cleanup: "rename", workspace: "verify" },
  { operation: "verify", failure: false, cleanup: "remove", workspace: "restore" },
  { operation: "verify", failure: true, cleanup: "remove", workspace: "verify" },
  { operation: "restore", failure: false, cleanup: "remove", workspace: "restore" },
  { operation: "restore", failure: true, cleanup: "remove", workspace: "restore" },
  { operation: "restore", failure: false, cleanup: "remove", workspace: "codec" },
  { operation: "restore", failure: true, cleanup: "remove", workspace: "codec" },
] as const)(
  "reports $operation $workspace cleanup $cleanup failures without replacing its primary outcome (failure=$failure)",
  async ({ operation, failure, cleanup, workspace }) => {
    const root = tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    const primary = new Error("synthetic backup I/O failure");
    const removal = Object.assign(new Error("EACCES: synthetic private cleanup failure"), {
      code: "EACCES",
    });
    const retained = new Set<string>();
    const prefix = workspace === "codec" ? ".git-backup-restore-" : `openclaw-git-${workspace}-`;
    const rename = fsSync.renameSync;
    const rm = fs.rm;
    const rmdir = fs.rmdir;
    const writeFile = fs.writeFile;
    const open = fs.open;
    const codec = workspace === "codec";
    const basename = (value: unknown) => path.basename(String(value));
    const failRestoreWrite = failure && operation !== "create" && !codec;
    const failCodecOpen = failure && codec;
    const nativeConfig = getFsSafeNativeConfig();
    configureFsSafeNative({ mode: "off" });
    try {
      await withBackupStateEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          if (operation !== "create") {
            await createGitBackup({ repositoryPath, stateDir, databases: [database] });
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
          vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
            if (
              failRestoreWrite &&
              typeof args[0] === "string" &&
              args[0].includes(`${path.sep}openclaw-git-restore-`)
            ) {
              throw primary;
            }
            return await writeFile(...args);
          });
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (failCodecOpen && String(args[0]).includes(`${path.sep}.git-backup-restore-`)) {
              throw primary;
            }
            return await open(...args);
          });
          try {
            const running =
              operation === "create"
                ? createGitBackup({ repositoryPath, stateDir, databases: [database] })
                : operation === "verify"
                  ? verifyGitBackupRef({ repositoryPath, identity: database.identity })
                  : restoreGitBackupRef({
                      repositoryPath,
                      identity: database.identity,
                      targetPath: path.join(root, "restored.sqlite"),
                    });
            if (failure) {
              await expect(running).rejects.toBe(primary);
            } else {
              await expect(running).resolves.toMatchObject({
                commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
              });
            }
            expect(warning).toHaveBeenCalledWith(
              expect.stringMatching(
                /Warning: Git backup temporary files may remain under .*; cleanup failed:/u,
              ),
            );
            if (!codec) {
              expect(warning).toHaveBeenCalledWith(
                expect.stringContaining(cleanup === "rename" ? "indeterminate" : "EACCES"),
              );
            }
            expect(retained.size).toBeGreaterThan(0);
            for (const retainedPath of retained) {
              expect((await fs.lstat(retainedPath)).isDirectory()).toBe(true);
              if (codec) {
                expect(warning).toHaveBeenCalledWith(expect.stringContaining(retainedPath));
              }
            }
            if (codec) {
              const targetPath = path.join(root, "restored.sqlite");
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
        },
      );
    } finally {
      configureFsSafeNative(nativeConfig);
    }
  },
);
