import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupCreateCommand } from "./backup.js";

const selectStyledMock = vi.hoisted(() => vi.fn());
const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/prompt-select-styled.js", () => ({
  selectStyled: selectStyledMock,
}));

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

const { backupListCommand, chooseBackupArchiveForRestore, resolveLatestBackupArchiveForRestore } =
  await import("./backup-catalog.js");

describe("backup catalog", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-catalog-");
    selectStyledMock.mockReset();
    noteMock.mockReset();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("lists validated backup versions sorted newest first and skips invalid tarballs", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-catalog-out-"));

    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const older = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-09T00:00:00.000Z"),
      });
      const newer = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-10T00:00:00.000Z"),
      });
      await fs.writeFile(path.join(archiveDir, "broken.tar.gz"), "not-a-tarball", "utf8");

      const result = await backupListCommand(runtime, {
        path: archiveDir,
      });

      const olderRealPath = await fs.realpath(older.archivePath);
      const newerRealPath = await fs.realpath(newer.archivePath);
      expect(result.archives.map((entry) => entry.archivePath)).toEqual([
        newerRealPath,
        olderRealPath,
      ]);
      expect(result.skipped).toHaveLength(1);
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Found 2 validated backup archives"),
      );
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Skipped 1 file"));
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("skips archives with invalid manifest createdAt and resolves the newest valid backup", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-catalog-bad-ts-"));

    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const valid = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-10T00:00:00.000Z"),
      });

      const rootName = "9999-12-31T23-59-59.999Z-openclaw-backup";
      const root = path.join(archiveDir, rootName);
      const payloadDir = path.join(root, "payload", "posix", "tmp", ".openclaw");
      await fs.mkdir(payloadDir, { recursive: true });
      await fs.writeFile(path.join(payloadDir, "state.txt"), "bad\n", "utf8");
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            createdAt: "not-a-real-timestamp",
            archiveRoot: rootName,
            runtimeVersion: "test",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "state",
                sourcePath: "/tmp/.openclaw",
                archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const invalidArchivePath = path.join(archiveDir, `${rootName}.tar.gz`);
      await tar.c({ file: invalidArchivePath, gzip: true, cwd: archiveDir }, [rootName]);
      await fs.rm(root, { recursive: true, force: true });

      const listed = await backupListCommand(runtime, { path: archiveDir });
      const resolved = await resolveLatestBackupArchiveForRestore({ searchPath: archiveDir });

      expect(listed.skipped.some((entry) => entry.archivePath === invalidArchivePath)).toBe(true);
      expect(resolved).toBe(await fs.realpath(valid.archivePath));
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("prompts for a backup version to restore from a directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-choose-out-"));

    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const older = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-09T00:00:00.000Z"),
      });
      const newer = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-10T00:00:00.000Z"),
      });

      const olderRealPath = await fs.realpath(older.archivePath);
      const newerRealPath = await fs.realpath(newer.archivePath);
      selectStyledMock.mockResolvedValueOnce(olderRealPath);

      const selected = await chooseBackupArchiveForRestore({
        runtime,
        searchPath: archiveDir,
      });

      expect(selected).toBe(olderRealPath);
      expect(selectStyledMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Choose a backup version to restore",
          options: [
            expect.objectContaining({
              value: newerRealPath,
              label: "2026-03-10T00:00:00.000Z",
            }),
            expect.objectContaining({
              value: olderRealPath,
              label: "2026-03-09T00:00:00.000Z",
            }),
          ],
        }),
      );
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("resolves the newest validated backup for default restore", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-latest-out-"));

    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-09T00:00:00.000Z"),
      });
      const newer = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs: Date.parse("2026-03-10T00:00:00.000Z"),
      });

      const resolved = await resolveLatestBackupArchiveForRestore({
        searchPath: archiveDir,
      });

      expect(resolved).toBe(await fs.realpath(newer.archivePath));
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("prefers the newest validated backup from the current working directory or Backups", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const backupsDir = path.join(tempHome.home, "Backups");
    const cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-catalog-cwd-"));
    const previousCwd = process.cwd();

    try {
      await fs.mkdir(backupsDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      await backupCreateCommand(runtime, {
        output: backupsDir,
        nowMs: Date.parse("2026-03-09T00:00:00.000Z"),
      });
      const newest = await backupCreateCommand(runtime, {
        output: cwdDir,
        nowMs: Date.parse("2026-03-10T00:00:00.000Z"),
      });

      process.chdir(cwdDir);
      const resolved = await resolveLatestBackupArchiveForRestore({});

      expect(resolved).toBe(await fs.realpath(newest.archivePath));
    } finally {
      process.chdir(previousCwd);
      await fs.rm(cwdDir, { recursive: true, force: true });
    }
  });

  it("finds default backups that were written to the home directory fallback", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const previousCwd = process.cwd();

    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      process.chdir(stateDir);
      const created = await backupCreateCommand(runtime, {
        nowMs: Date.parse("2026-03-11T00:00:00.000Z"),
      });
      const resolved = await resolveLatestBackupArchiveForRestore({});

      expect(created.archivePath).toBe(
        path.join(tempHome.home, path.basename(created.archivePath)),
      );
      expect(resolved).toBe(await fs.realpath(created.archivePath));
    } finally {
      process.chdir(previousCwd);
      await fs
        .readdir(tempHome.home)
        .then((entries) =>
          Promise.all(
            entries
              .filter((entry) => entry.endsWith(".tar.gz"))
              .map((entry) => fs.rm(path.join(tempHome.home, entry), { force: true })),
          ),
        );
    }
  });
});
