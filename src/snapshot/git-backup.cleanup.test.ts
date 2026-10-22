import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";

const roots: string[] = [];

async function withBackupStateEnv<T>(
  values: Parameters<typeof withEnvAsync>[0],
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync(values, async () => {
    await using state = {
      run,
      async [Symbol.asyncDispose]() {
        await closeOpenClawStateDatabaseAsync();
      },
    };
    return await state.run();
  });
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createStateDatabaseFixture(root: string): {
  stateDir: string;
  database: { path: string; identity: { role: "global" } };
} {
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return {
    stateDir,
    database: {
      path: resolveOpenClawStateSqlitePath(env),
      identity: { role: "global" },
    },
  };
}

describe("Git backup scratch cleanup", () => {
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
      const root = await tempRoot();
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
              const name = path.basename(String(source));
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
              if (workspace === "codec" && path.basename(String(args[0])).startsWith(prefix)) {
                retained.add(String(args[0]));
                throw removal;
              }
              if (retained.has(String(args[0]))) {
                throw removal;
              }
              if (
                failure &&
                operation === "create" &&
                path.basename(String(args[0])) === "global-0.sqlite"
              ) {
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
                failure &&
                operation !== "create" &&
                workspace !== "codec" &&
                typeof args[0] === "string" &&
                args[0].includes(`${path.sep}openclaw-git-restore-`)
              ) {
                throw primary;
              }
              return await writeFile(...args);
            });
            vi.spyOn(fs, "open").mockImplementation(async (...args) => {
              if (
                failure &&
                workspace === "codec" &&
                String(args[0]).includes(`${path.sep}.git-backup-restore-`)
              ) {
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
              if (workspace !== "codec") {
                expect(warning).toHaveBeenCalledWith(
                  expect.stringContaining(cleanup === "rename" ? "indeterminate" : "EACCES"),
                );
              }
              expect(retained.size).toBeGreaterThan(0);
              for (const retainedPath of retained) {
                expect((await fs.lstat(retainedPath)).isDirectory()).toBe(true);
                if (workspace === "codec") {
                  expect(warning).toHaveBeenCalledWith(expect.stringContaining(retainedPath));
                }
              }
              if (workspace === "codec") {
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
});
