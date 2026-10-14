import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi, afterEach, describe } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntryDetails } from "./backup-create.test-support.js";
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
        await expect(
          fs.stat(path.join(scratchRoot, scratch!, "owner.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
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

describe("backup traversal", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["lstat", "open"] as const)(
    "records a file vanishing before %s and restores survivors",
    async (operation) => {
      await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        });
        const vanished = path.join(state.workspaceDir, "racing.json");
        const survivor = path.join(state.workspaceDir, "keep.txt");
        await fs.writeFile(vanished, "temporary contents");
        await fs.writeFile(survivor, "durable contents");
        let removed = false;
        const remove = (target: unknown) => {
          if (target === vanished && !removed) {
            fsSync.unlinkSync(vanished);
            removed = true;
          }
        };
        if (operation === "lstat") {
          // Keep the same race reproducible on both filesystem APIs used by the writers.
          const callbackLstat = fsSync.lstat;
          vi.spyOn(fsSync, "lstat").mockImplementation((...args) => {
            remove(args[0]);
            return callbackLstat(...args);
          });
          const original = fs.lstat;
          vi.spyOn(fs, "lstat").mockImplementation((...args) => {
            remove(args[0]);
            return original(...args);
          });
        } else {
          const callbackOpen = fsSync.open;
          vi.spyOn(fsSync, "open").mockImplementation((...args) => {
            remove(args[0]);
            return callbackOpen(...args);
          });
          const original = fs.open;
          vi.spyOn(fs, "open").mockImplementation((...args) => {
            remove(args[0]);
            return original(...args);
          });
        }
        const runtime = createTestRuntime();
        const result = await backupCreateCommand(runtime, {
          output: state.path("backup.tar.gz"),
          verify: true,
        });
        expect(removed).toBe(true);
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ sourcePath: vanished, reason: "vanished" }),
        );
        expect(result.warnings).toContain(`Skipped vanished entry (ENOENT): ${vanished}`);
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(`Skipped vanished entry (ENOENT): ${vanished}`),
        );
        const entries = await listArchiveEntryDetails(result.archivePath);
        expect(entries.some((entry) => entry.path.endsWith("/racing.json"))).toBe(false);
        const keep = entries.find((entry) => entry.path.endsWith("/keep.txt"));
        expect(keep).toBeDefined();
        const restored = await backupRestoreCommand(runtime, {
          archive: result.archivePath,
          target: state.path("restored"),
        });
        expect(await fs.readFile(path.join(restored.targetPath, keep!.path), "utf8")).toBe(
          "durable contents",
        );
      });
    },
  );

  it("reports transient files in a second workspace and preserves its dangling absolute link", async () => {
    await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
      const second = state.path("second-workspace");
      await fs.mkdir(second);
      await state.writeConfig({
        agents: {
          entries: { main: { workspace: state.workspaceDir }, second: { workspace: second } },
        },
      });
      const transient = ["pending.tmp", "queue.json.tmp.123.456"];
      for (const name of [...transient, "keep.txt"]) {
        await fs.writeFile(path.join(second, name), name);
      }
      const dangling = state.path("missing-target");
      const sourceLink = path.join(second, "dangling-link");
      await fs.symlink(dangling, sourceLink, process.platform === "win32" ? "junction" : "file");
      const linkpath = (await fs.readlink(sourceLink)).replaceAll(path.sep, "/");
      const result = await backupCreateCommand(createTestRuntime(), {
        output: state.path("backup.tar.gz"),
        verify: true,
        json: true,
      });
      const entries = await listArchiveEntryDetails(result.archivePath);
      expect(entries.some((entry) => entry.path.endsWith("/second-workspace/keep.txt"))).toBe(true);
      for (const name of transient) {
        expect(entries.some((entry) => entry.path.endsWith(`/second-workspace/${name}`))).toBe(
          false,
        );
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ sourcePath: path.join(second, name), reason: "volatile" }),
        );
      }
      expect(result.skippedVolatileCount).toBe(2);
      const link = entries.find((entry) => entry.path.endsWith("/second-workspace/dangling-link"));
      expect(link).toMatchObject({ type: "SymbolicLink", linkpath });
      expect(result.externalSymbolicLinks).toContainEqual({
        entryPath: link!.path,
        linkpath,
      });
    });
  });

  it.each([
    "replace-before-open",
    "unlink-after-open",
    ...(fsSync.constants.O_NOFOLLOW ? ["replace-around-open" as const] : []),
  ] as const)("archives a complete regular file through %s", async (mutation) => {
    await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
      // Keep concurrent backups out of this fixture's warning inventory.
      const scratchRoot = state.path("scratch");
      await fs.mkdir(scratchRoot);
      Object.assign(state.envVars, { TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot });
      state.applyEnv();
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const source = path.join(state.workspaceDir, "current.txt");
      const replacement = state.path("replacement");
      await fs.writeFile(source, "before");
      await fs.writeFile(replacement, "after");
      const open = fs.open;
      let mutated = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] !== source || mutated) {
          return await open(...args);
        }
        mutated = true;
        if (mutation !== "unlink-after-open") {
          await fs.rename(replacement, source);
          const handle = await open(...args);
          if (mutation === "replace-around-open") {
            await fs.writeFile(replacement, "latest");
            await fs.rename(replacement, source);
          }
          return handle;
        }
        const handle = await open(...args);
        await fs.unlink(source);
        return handle;
      });
      const runtime = createTestRuntime();
      const archive = await backupCreateCommand(runtime, {
        output: state.path("backup.tar.gz"),
        verify: true,
      });
      const restored = await backupRestoreCommand(runtime, {
        archive: archive.archivePath,
        target: state.path("restored"),
      });
      const archivedEntry = (await listArchiveEntryDetails(archive.archivePath)).find((entry) =>
        entry.path.endsWith("/current.txt"),
      );
      expect(mutated).toBe(true);
      expect(await fs.readFile(path.join(restored.targetPath, archivedEntry!.path), "utf8")).toBe(
        mutation === "unlink-after-open" ? "before" : "after",
      );
      expect(archive.warnings ?? []).toEqual([]);
    });
  });

  it.each(["ENOENT", "EACCES"])(
    "refuses missing required config or source I/O errors: %s",
    async (code) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        await state.writeConfig({});
        const source =
          code === "ENOENT" ? state.configPath : await state.writeText("keep.txt", "data");
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (args[0] === source) {
            throw Object.assign(new Error(`injected ${code}`), { code, path: source });
          }
          return await open(...args);
        });
        const output = state.path("backup.tar.gz");
        await expect(
          backupCreateCommand(createTestRuntime(), { output, onlyConfig: code === "ENOENT" }),
        ).rejects.toThrow(
          code === "ENOENT" ? "Required backup source disappeared" : `injected ${code}`,
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("reports many volatile paths without overflowing the restore manifest", async () => {
    await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const files = Array.from({ length: 9_000 }, (_, index) =>
        path.join(state.workspaceDir, `pending-${index}.tmp.123`),
      );
      for (let offset = 0; offset < files.length; offset += 64) {
        await Promise.all(files.slice(offset, offset + 64).map((file) => fs.writeFile(file, "")));
      }
      const result = await backupCreateCommand(createTestRuntime(), {
        output: state.path("backup.tar.gz"),
        verify: true,
        json: true,
      });
      expect(result.verified).toBe(true);
      expect(result.skippedVolatileCount).toBe(files.length);
      expect(
        result.skipped
          .filter((entry) => entry.reason === "volatile")
          .map((entry) => entry.sourcePath)
          .toSorted(),
      ).toEqual(files.toSorted());
    });
  });
});

describe("backup stream lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  type ReportBackupProgress = Parameters<
    Parameters<typeof writeArchiveStreamToFile>[0]["createArchiveStream"]
  >[0];

  describe("writeArchiveStreamToFile", () => {
    it("removes the exclusive partial archive when its initial descriptor stat fails", async () => {
      const tempDir = tempDirs.make("openclaw-backup-stream-fstat-");
      const archivePath = path.join(tempDir, "partial.tar.gz");
      const archiveStream = new PassThrough();
      const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("fstat failed"), { code: "EIO" });
      });
      try {
        const writePromise = writeArchiveStreamToFile({
          archivePath,
          createArchiveStream: () => archiveStream,
          onPartialArchive: vi.fn(),
        });
        archiveStream.end("partial archive");

        await expect(writePromise).rejects.toThrow("fstat failed");
        await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        fstatSpy.mockRestore();
      }
    });

    it("aborts and closes a partial archive when the source stops producing data", async () => {
      vi.useFakeTimers();
      try {
        const tempDir = tempDirs.make("openclaw-backup-stream-timeout-");
        const archivePath = path.join(tempDir, "partial.tar.gz");
        const archiveStream = new PassThrough();
        const writePromise = writeArchiveStreamToFile({
          archivePath,
          createArchiveStream: () => archiveStream,
          onPartialArchive: vi.fn(),
        });
        archiveStream.write("partial archive");

        const rejection = expect(writePromise).rejects.toThrow(
          "Backup archive write stalled: no progress observed for 300000ms",
        );
        await vi.advanceTimersByTimeAsync(300_001);
        await rejection;
        expect(archiveStream.destroyed).toBe(true);
        await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the archive alive through more than five minutes of one entry's raw bytes", async () => {
      vi.useFakeTimers();
      try {
        const tempDir = tempDirs.make("openclaw-backup-stream-entry-progress-");
        const archivePath = path.join(tempDir, "complete.tar.gz");
        const archiveStream = new PassThrough();
        let reportProgress: ReportBackupProgress | undefined;
        const writePromise = writeArchiveStreamToFile({
          archivePath,
          createArchiveStream: (progress) => {
            reportProgress = progress;
            return archiveStream;
          },
          onPartialArchive: vi.fn(),
        });
        for (let elapsed = 0; elapsed < 360_000; elapsed += 60_000) {
          await vi.advanceTimersByTimeAsync(60_000);
          reportProgress?.({ phase: "raw", entryPath: "/source/large.pack", bytes: 16 });
        }
        archiveStream.end("archive after one large entry");

        await expect(writePromise).resolves.toMatchObject({ archivePath });
        await expect(fs.readFile(archivePath, "utf8")).resolves.toBe(
          "archive after one large entry",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      {
        entryPath: `/source/🤖${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`,
        expectedPath: `${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`,
      },
    ])(
      "cleans a stalled archive and preserves its entry suffix: $entryPath",
      async ({ entryPath, expectedPath }) => {
        vi.useFakeTimers();
        try {
          const tempDir = tempDirs.make("openclaw-backup-stream-entry-timeout-");
          const archivePath = path.join(tempDir, "partial.tar.gz");
          const archiveStream = new PassThrough();
          let reportProgress: ReportBackupProgress | undefined;
          const writePromise = writeArchiveStreamToFile({
            archivePath,
            createArchiveStream: (progress) => {
              reportProgress = progress;
              return archiveStream;
            },
            onPartialArchive: vi.fn(),
          });
          reportProgress?.({ phase: "raw", entryPath, bytes: 16 });
          archiveStream.write("partial archive");

          const rejection = expect(writePromise).rejects.toThrow(
            `Backup archive write stalled: no progress observed for 300000ms (phase=output, entry=${JSON.stringify(expectedPath)}, rawBytes=16, outputBytes=15)`,
          );
          await vi.advanceTimersByTimeAsync(300_001);
          await rejection;
          await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });
});
