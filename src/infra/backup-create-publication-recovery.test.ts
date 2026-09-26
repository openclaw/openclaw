import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchivePublication } from "./backup-archive-publication.js";
import { createBackupArchive } from "./backup-create.js";
import * as scratch from "./backup-scratch.js";
import { markSqliteNativeOpenFailure } from "./sqlite-error-diagnostics.js";

it("reclaims abandoned publication retries through the real backup creation flow", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "backup-create-publication-recovery-" },
    async (state) => {
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir);
      const abandoned = await createBackupArchivePublication(
        path.join(outputDir, "abandoned.tar.gz"),
      );
      try {
        for (const suffix of ["", ".retry-2", ".retry-3"]) {
          await fs.writeFile(`${abandoned.tempArchivePath}${suffix}`, "unfinished archive");
        }
      } finally {
        abandoned.scratch!.release();
      }
      const result = await createBackupArchive({
        output: outputDir,
        onlyConfig: true,
        includeWorkspace: false,
        nowMs: Date.UTC(2026, 8, 23, 12),
      });
      expect(result.dryRun).toBe(false);
      expect((await fs.stat(result.archivePath)).size).toBeGreaterThan(0);
      await expect(fs.readdir(outputDir)).resolves.toEqual([path.basename(result.archivePath)]);
    },
  );
});

it("returns publication maintenance warnings in the structured backup result", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "backup-publication-warning-" },
    async (state) => {
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir);
      const preserved = path.join(outputDir, ".openclaw-backup-publish-owned-abcdef");
      await fs.writeFile(preserved, "not a directory");
      const result = await createBackupArchive({
        output: outputDir,
        onlyConfig: true,
        includeWorkspace: false,
        nowMs: Date.UTC(2026, 8, 23, 13),
      });
      expect(result.warnings).toEqual([
        expect.stringContaining(`Backup scratch entry preserved at ${preserved}: not a directory`),
      ]);
      await expect(fs.readFile(preserved, "utf8")).resolves.toBe("not a directory");
    },
  );
});

it("publishes with a structured warning when destination SQLite staging is unavailable", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "backup-publication-no-sqlite-" },
    async (state) => {
      const createScratch = scratch.createBackupScratchDirectory;
      const admissionError = Object.assign(new Error("synthetic unsupported SQLite locking"), {
        code: "SQLITE_IOERR",
      });
      markSqliteNativeOpenFailure(admissionError);
      const allocation = vi
        .spyOn(scratch, "createBackupScratchDirectory")
        .mockImplementation(async (root, kind) => {
          if (kind === "publication") {
            throw admissionError;
          }
          return await createScratch(root, kind);
        });
      try {
        const result = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          onlyConfig: true,
          includeWorkspace: false,
        });
        expect(result.warnings).toEqual([
          expect.stringContaining("does not support recoverable SQLite staging"),
        ]);
        await expect(fs.stat(result.archivePath)).resolves.toMatchObject({
          size: expect.any(Number),
        });
        expect(allocation).toHaveBeenCalledWith(expect.any(String), "publication");
      } finally {
        allocation.mockRestore();
      }
    },
  );
});

it("returns publication retirement failures in the structured backup result", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "backup-publication-retirement-warning-" },
    async (state) => {
      const rmdir = fs.rmdir;
      const retirement = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
        if (path.basename(String(target)).startsWith(".openclaw-backup-publish-retired-")) {
          throw Object.assign(new Error("synthetic publication cleanup failure"), {
            code: "EBUSY",
          });
        }
        return await rmdir(target);
      });
      try {
        const result = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          onlyConfig: true,
          includeWorkspace: false,
        });
        expect(result.warnings).toEqual([
          expect.stringContaining("synthetic publication cleanup failure"),
        ]);
        await expect(fs.stat(result.archivePath)).resolves.toMatchObject({
          size: expect.any(Number),
        });
      } finally {
        retirement.mockRestore();
      }
    },
  );
});
