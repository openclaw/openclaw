import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import * as directoryDurability from "./directory-durability.js";

it("reclaims an interrupted archive's scratch on the next backup run", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "backup-scratch-next-run-", scenario: "minimal" },
    async (state) => {
      const scratchRoot = state.path("scratch");
      await fs.mkdir(scratchRoot);
      vi.stubEnv("TMPDIR", scratchRoot);
      const stale = await createBackupScratchDirectory(scratchRoot);
      const live = await createBackupScratchDirectory(scratchRoot);
      stale.release();
      try {
        await fs.writeFile(path.join(stale.directory, "config-0"), "abandoned");
        await fs.writeFile(path.join(live.directory, "config-0"), "active");
        await createBackupArchive({ output: state.path("backup.tar.gz"), onlyConfig: true });
        await expect(fs.stat(stale.directory)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(path.join(live.directory, "config-0"), "utf8")).resolves.toBe(
          "active",
        );
      } finally {
        await finishBackupScratch(live);
        vi.unstubAllEnvs();
      }
    },
  );
});

it("records failed scratch cleanup without failing the published backup", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "backup-scratch-cleanup-", scenario: "minimal" },
    async (state) => {
      const scratchRoot = state.path("scratch");
      await fs.mkdir(scratchRoot);
      vi.stubEnv("TMPDIR", scratchRoot);
      const remove = fs.rmdir.bind(fs);
      const removal = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
        if (path.dirname(String(target)) === scratchRoot) {
          throw Object.assign(new Error("synthetic cleanup denied"), { code: "EACCES" });
        }
        return remove(target);
      });
      try {
        const log = vi.fn();
        const result = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          onlyConfig: true,
          log,
        });
        const [scratch] = await fs.readdir(scratchRoot);
        expect(scratch).toMatch(/^openclaw-backup-/u);
        const warning = expect.stringContaining(path.join(scratchRoot, scratch!));
        expect(result.warnings).toEqual(expect.arrayContaining([warning]));
        expect(log).toHaveBeenCalledWith(warning);
        await expect(fs.stat(result.archivePath)).resolves.toMatchObject({
          size: expect.any(Number),
        });
        removal.mockRestore();
        const repaired = await maintainBackupScratch({ roots: [scratchRoot], repair: true });
        expect(repaired.reclaimed).toEqual([path.join(scratchRoot, scratch!)]);
        await expect(fs.readdir(scratchRoot)).resolves.toEqual([]);
      } finally {
        removal.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );
});

it("fails closed when the backup destination does not support hard links", async () => {
  const publicationSpy = vi
    .spyOn(directoryDurability, "publishFileExclusive")
    .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "EPERM" }));
  try {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-no-hardlinks-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          }),
        ).rejects.toThrow(/requires hard-link support/iu);
        expect(publicationSpy).toHaveBeenCalledWith(
          expect.objectContaining({ strategy: "link-required" }),
        );
        await expect(fs.readdir(outputDir)).resolves.toEqual([]);
      },
    );
  } finally {
    publicationSpy.mockRestore();
  }
});
