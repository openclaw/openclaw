import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";

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

  it("closes a partial archive before propagating a stream error", async () => {
    const tempDir = tempDirs.make("openclaw-backup-stream-");
    const archivePath = path.join(tempDir, "partial.tar.gz");
    const archiveStream = new PassThrough();
    const writePromise = writeArchiveStreamToFile({
      archivePath,
      createArchiveStream: () => archiveStream,
      onPartialArchive: vi.fn(),
    });
    archiveStream.write("partial archive");
    archiveStream.destroy(new Error("injected tar read failure"));

    await expect(writePromise).rejects.toThrow("injected tar read failure");
    await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("resets the idle timeout when archive data keeps arriving", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-progress-");
      const archivePath = path.join(tempDir, "complete.tar.gz");
      const archiveStream = new PassThrough();
      const writePromise = writeArchiveStreamToFile({
        archivePath,
        createArchiveStream: () => archiveStream,
        onPartialArchive: vi.fn(),
      });

      archiveStream.write("first");
      await vi.advanceTimersByTimeAsync(240_000);
      archiveStream.write("second");
      await vi.advanceTimersByTimeAsync(240_000);
      archiveStream.end("third");

      await expect(writePromise).resolves.toMatchObject({ archivePath });
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("firstsecondthird");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the archive alive while the producer reports silent traversal progress", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = tempDirs.make("openclaw-backup-stream-traversal-progress-");
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
        reportProgress?.();
      }
      archiveStream.end("archive after traversal");

      await expect(writePromise).resolves.toMatchObject({ archivePath });
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("archive after traversal");
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
      await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("archive after one large entry");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { entryPath: "/source/stalled.pack", expectedPath: "/source/stalled.pack" },
    {
      entryPath: `/source/🤖${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`,
      expectedPath: `${"a".repeat(170)}/${"b".repeat(170)}/${"c".repeat(169)}`,
    },
    { entryPath: "/source/🤖/stalled.pack", expectedPath: "/source/🤖/stalled.pack" },
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
