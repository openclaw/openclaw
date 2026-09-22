import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

describe.skipIf(process.platform === "win32")("backup SQLite symbolic link loops", () => {
  it("skips an unmanaged loop with one filename warning and restores adjacent files", async () => {
    await withOpenClawTestState(
      { layout: "split", prefix: "backup-opaque-link-", scenario: "minimal" },
      async (state) => {
        const sideFile = await state.writeText("foreign/keep.txt", "keep this file\n");
        const loopPath = state.statePath("foreign", "cycle.sqlite");
        await fs.symlink("cycle.sqlite", loopPath);
        const runtime = createTestRuntime();
        const archive = await backupCreateCommand(runtime, {
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
          verify: true,
        });

        expect(archive.verified).toBe(true);
        expect(archive.warnings).toHaveLength(1);
        const warning = expectDefined(archive.warnings?.[0], "skipped link warning");
        expect(warning).toContain("cycle.sqlite");
        expect(warning).toMatch(/skip/iu);
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(warning));
        const stateAsset = expectDefined(
          archive.assets.find((asset) => asset.kind === "state"),
          "state asset",
        );
        const archivedDirectory = path.posix.join(stateAsset.archivePath, "foreign");
        const entries: string[] = [];
        await tar.t({
          file: archive.archivePath,
          gzip: true,
          onentry: (entry) => {
            entries.push(entry.path);
            entry.resume();
          },
        });
        expect(entries).not.toContain(`${archivedDirectory}/cycle.sqlite`);
        expect(entries).toContain(`${archivedDirectory}/keep.txt`);

        const restored = await backupRestoreCommand(runtime, {
          archive: archive.archivePath,
          target: state.path("restored"),
        });
        const restoredDirectory = path.join(restored.targetPath, archivedDirectory);
        expect(await fs.readdir(restoredDirectory)).toEqual(["keep.txt"]);
        expect(await fs.readFile(path.join(restoredDirectory, "keep.txt"), "utf8")).toBe(
          "keep this file\n",
        );
        expect(await fs.readlink(loopPath)).toBe("cycle.sqlite");
        expect(await fs.readFile(sideFile, "utf8")).toBe("keep this file\n");
      },
    );
  });

  it.each(["canonical", "declared plugin"] as const)(
    "refuses a %s loop without publishing an archive",
    async (ownership) => {
      await withOpenClawTestState(
        { layout: "split", prefix: "backup-owned-link-", scenario: "minimal" },
        async (state) => {
          if (ownership === "declared plugin") {
            const rootDir = state.path("backup-plugin");
            await fs.mkdir(rootDir);
            const plugin = createColdPluginFixture({
              rootDir,
              pluginId: "backup-owner",
              manifest: {
                backupResources: [
                  { disposition: "include", scope: "state", relativePath: "foreign" },
                ],
              },
            });
            await state.writeConfig(createColdPluginConfig(rootDir, plugin.pluginId));
          }
          const loopPath =
            ownership === "canonical"
              ? resolveOpenClawStateSqlitePath(state.env)
              : state.statePath("foreign", "cycle.sqlite");
          await fs.mkdir(path.dirname(loopPath), { recursive: true });
          await fs.symlink(path.basename(loopPath), loopPath);
          const output = state.path("rejected.tar.gz");

          try {
            await expect(
              backupCreateCommand(createTestRuntime(), {
                output,
                includeWorkspace: false,
                verify: true,
              }),
            ).rejects.toThrow(/ELOOP|too many (?:levels of )?symbolic links/iu);
            await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await fs.readlink(loopPath)).toBe(path.basename(loopPath));
          } finally {
            await fs.unlink(loopPath);
          }
        },
      );
    },
  );
});
