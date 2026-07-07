// Windows-specific regression coverage for backup archive cleanup EBUSY retry.
// These tests exercise the fs.rm retry loop added in writeTarArchiveWithRetry to
// prevent tar retry cascade on Windows when a temp archive is still locked.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { testApi as backupCreateInternals } from "./backup-create.js";

describe("writeTarArchiveWithRetry cleanup EBUSY (Windows)", () => {
  it("retries fs.rm on EBUSY and continues to the next tar attempt after the rm succeeds", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const ebusyErr = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    const rmSpy = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(ebusyErr)
      .mockResolvedValueOnce(undefined);

    try {
      await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(2);
      // EBUSY retry sleep, then tar backoff sleep
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 10_000);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("logs and continues to the next tar attempt when EBUSY persists after 3 rm attempts", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const ebusyErr = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(ebusyErr);

    try {
      await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(3);
      // Two 100ms EBUSY backoff sleeps, then tar backoff
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 100);
      expect(sleep).toHaveBeenNthCalledWith(3, 10_000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("/tmp/backup.tar.gz.tmp"));
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("silently ignores ENOENT during rm cleanup between tar retries", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const enoentErr = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(enoentErr);

    try {
      await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(1);
      // The outer loop logs a tar retry message; the cleanup path must not
      // log an rm error when the code is ENOENT.
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("could not remove temp archive"),
      );
      expect(sleep).not.toHaveBeenCalledWith(100);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("logs non-EBUSY, non-ENOENT cleanup errors once without retrying rm", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const eaccesErr = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(eaccesErr);

    try {
      await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      expect(sleep).not.toHaveBeenCalledWith(100);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("does not log or retry when the cleanup error has no code", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const noCodeErr = new Error("some unknown cleanup failure");
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(noCodeErr);

    try {
      await backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(1);
      // The outer loop logs a tar retry message; the cleanup path must not
      // log an rm error when the error has no code.
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("could not remove temp archive"),
      );
      expect(sleep).not.toHaveBeenCalledWith(100);
    } finally {
      rmSpy.mockRestore();
    }
  });
});
