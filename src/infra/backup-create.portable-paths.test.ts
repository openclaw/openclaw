import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { withIsolatedBackupState } from "./backup-create.test-support.js";
import * as backupSqliteSnapshot from "./backup-sqlite-snapshot.js";
import * as backupTarWalk from "./backup-tar-walk.js";
import { hasErrnoCode } from "./errno.js";

const nowMs = Date.UTC(2026, 10, 20, 8, 0, 0);

async function writeCaseOnlyPair(
  dir: string,
  skip: (note: string) => never,
  names = ["Example_0.json", "example_0.json"],
): Promise<{ upper: string; lower: string }> {
  await fs.mkdir(dir, { recursive: true });
  const upper = path.join(dir, names[0]);
  const lower = path.join(dir, names[1]);
  await fs.writeFile(upper, '{"variant":"upper"}\n');
  try {
    await fs.writeFile(lower, '{"variant":"lower"}\n', { flag: "wx" });
  } catch (error) {
    if (hasErrnoCode(error, "EEXIST")) {
      skip("requires a case-sensitive filesystem");
    }
    throw error;
  }
  return { upper, lower };
}

function withWorkspaceState(
  run: (state: OpenClawTestState, outputDir: string) => Promise<void>,
  workspaceDir = (state: OpenClawTestState) => state.workspaceDir,
) {
  return withIsolatedBackupState(
    { layout: "split", prefix: "openclaw-backup-portable-", scenario: "minimal" },
    async (state) => {
      await state.writeConfig({
        agents: { entries: { main: { workspace: workspaceDir(state) } } },
      });
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir, { recursive: true });
      await run(state, outputDir);
    },
  );
}

it("rejects included case-only path collisions before capture or archive writes", async ({
  skip,
}) => {
  await withWorkspaceState(async (state, outputDir) => {
    const { upper, lower } = await writeCaseOnlyPair(
      path.join(state.workspaceDir, "artifacts"),
      skip,
    );
    using snapshots = vi.spyOn(backupSqliteSnapshot, "createBackupSqliteSnapshotPlan");
    using walk = vi.spyOn(backupTarWalk, "walkBackupTar");

    const error = await createBackupArchive({
      output: outputDir,
      includeWorkspace: true,
      nowMs,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/differ only by letter case or Unicode normalization/u);
    expect(message).toContain(upper);
    expect(message).toContain(lower);
    expect(message).toContain("--no-include-workspace");
    expect(snapshots).not.toHaveBeenCalled();
    expect(walk).not.toHaveBeenCalled();
    expect(await fs.readdir(outputDir)).toEqual([]);
    expect(await fs.readFile(upper, "utf8")).toBe('{"variant":"upper"}\n');
    expect(await fs.readFile(lower, "utf8")).toBe('{"variant":"lower"}\n');
  });
});

it("rejects names that differ only by Unicode normalization", async () => {
  await withWorkspaceState(async (state, outputDir) => {
    const composed = path.join(state.workspaceDir, "caf\u00e9.md");
    const decomposed = path.join(state.workspaceDir, "cafe\u0301.md");
    await fs.writeFile(composed, "composed\n");
    await fs.writeFile(decomposed, "decomposed\n", { flag: "a" });
    const names = await fs.readdir(state.workspaceDir);
    // Normalizing filesystems store both spellings as one file.
    const distinct = names.includes("caf\u00e9.md") && names.includes("cafe\u0301.md");

    const created = createBackupArchive({ output: outputDir, includeWorkspace: true, nowMs });
    if (distinct) {
      await expect(created).rejects.toThrow(/differ only by letter case or Unicode normalization/u);
      expect(await fs.readdir(outputDir)).toEqual([]);
    } else {
      await expect(created).resolves.toMatchObject({ dryRun: false });
    }
  });
});

it("does not reject collisions inside excluded workspaces", async ({ skip }) => {
  await withWorkspaceState(async (state, outputDir) => {
    await writeCaseOnlyPair(path.join(state.workspaceDir, "artifacts"), skip);

    const result = await createBackupArchive({
      output: outputDir,
      includeWorkspace: false,
      nowMs,
    });

    await expect(verifyBackupArchive(result.archivePath)).resolves.toMatchObject({
      ok: true,
    });
  });
});

it("suggests --no-include-workspace for a workspace nested in the state directory", async ({
  skip,
}) => {
  await withWorkspaceState(
    async (state, outputDir) => {
      await writeCaseOnlyPair(state.statePath("workspace", "artifacts"), skip);

      await expect(
        createBackupArchive({ output: outputDir, includeWorkspace: true, nowMs }),
      ).rejects.toThrow(/Rename or move one of them or pass --no-include-workspace/u);
      expect(await fs.readdir(outputDir)).toEqual([]);
    },
    (state) => state.statePath("workspace"),
  );
});

it("ignores collisions between transient SQLite files the archive omits", async ({ skip }) => {
  await withWorkspaceState(async (state, outputDir) => {
    await writeCaseOnlyPair(state.statePath("memory"), skip, [
      "main.sqlite.reindex-lock.sqlite",
      "Main.sqlite.reindex-lock.sqlite",
    ]);

    const result = await createBackupArchive({ output: outputDir, includeWorkspace: true, nowMs });

    await expect(verifyBackupArchive(result.archivePath)).resolves.toMatchObject({ ok: true });
  });
});
