import fs from "node:fs/promises";
import path from "node:path";
import type { TempWorkspace, TempWorkspaceCleanupResult } from "@openclaw/fs-safe/temp";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";
import { createStateDatabaseFixture, withBackupStateEnv } from "./git-backup.test-support.js";

// fs-safe owns how a workspace is removed (native owned-tree removal or the
// compatible JS path), so failures are injected at its cleanup result. Native
// stays on: Darwin private store creation requires the native ACL inspector.
const workspaceCleanup = vi.hoisted(() => ({
  failure: undefined as
    | {
        prefix: string;
        retained: Set<string>;
        cleanup: () => Promise<TempWorkspaceCleanupResult>;
      }
    | undefined,
  handles: [] as TempWorkspace[],
}));
vi.mock("@openclaw/fs-safe/temp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/temp")>();
  return {
    ...actual,
    tempWorkspace: async (...args: Parameters<typeof actual.tempWorkspace>) => {
      const workspace = await actual.tempWorkspace(...args);
      const failure = workspaceCleanup.failure;
      if (!failure || args[0]?.prefix !== failure.prefix) {
        return workspace;
      }
      failure.retained.add(workspace.dir);
      workspaceCleanup.handles.push(workspace);
      return { ...workspace, cleanup: failure.cleanup };
    },
  };
});

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  workspaceCleanup.failure = undefined;
  for (const workspace of workspaceCleanup.handles.splice(0)) {
    await workspace.cleanup();
  }
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
    const codec = workspace === "codec";
    const retained = new Set<string>();
    const { rm, open } = fs;
    const basename = (value: unknown) => path.basename(String(value));
    await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      if (operation !== "create") {
        await createGitBackup(backup);
      }
      const warning = vi.spyOn(console, "error").mockImplementation(() => {});
      if (!codec) {
        // Mirrors fs-safe's outcomes: a failed quarantine rename leaves the
        // removal indeterminate; a failed removal rejects with its I/O error.
        workspaceCleanup.failure = {
          prefix: `openclaw-git-${workspace}-`,
          retained,
          cleanup:
            cleanup === "rename"
              ? async () => "indeterminate"
              : async () => {
                  throw removal;
                },
        };
      }
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (codec && basename(args[0]).startsWith(".git-backup-restore-")) {
          retained.add(String(args[0]));
          throw removal;
        }
        if (failure && operation === "create" && basename(args[0]) === "global-0.sqlite") {
          throw primary;
        }
        return await rm(...args);
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
          // Workspace warnings name the parent that holds the retained directory.
          expect(diagnostics).toContain(codec ? retainedPath : path.dirname(retainedPath));
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
