import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openVerifiedFileSync } from "./safe-open-sync.js";

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(`open failed: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("openVerifiedFileSync", () => {
  it("falls back to O_RDONLY when O_NOFOLLOW open returns EINVAL", () => {
    withTempDir("openclaw-safe-open-", (dir) => {
      const filePath = path.join(dir, "sample.txt");
      fs.writeFileSync(filePath, "ok", "utf-8");
      const noFollowFlag = 0x20000000;
      let openCalls = 0;
      const ioFs = {
        ...fs,
        constants: {
          ...fs.constants,
          O_NOFOLLOW: noFollowFlag,
        },
        openSync(targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number {
          const numericFlags = typeof flags === "number" ? flags : Number.NaN;
          openCalls += 1;
          if (openCalls === 1) {
            expect((numericFlags & noFollowFlag) !== 0).toBe(true);
            throw createErrno("EINVAL");
          }
          expect(numericFlags).toBe(fs.constants.O_RDONLY);
          return fs.openSync(targetPath, flags, mode);
        },
      };

      const opened = openVerifiedFileSync({
        filePath,
        ioFs,
      });
      expect(opened.ok).toBe(true);
      expect(openCalls).toBe(2);
      if (opened.ok) {
        fs.closeSync(opened.fd);
      }
    });
  });

  it("falls back to O_RDONLY when O_NOFOLLOW open returns ENOTSUP", () => {
    withTempDir("openclaw-safe-open-", (dir) => {
      const filePath = path.join(dir, "sample.txt");
      fs.writeFileSync(filePath, "ok", "utf-8");
      const noFollowFlag = 0x10000000;
      let openCalls = 0;
      const ioFs = {
        ...fs,
        constants: {
          ...fs.constants,
          O_NOFOLLOW: noFollowFlag,
        },
        openSync(targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number {
          const numericFlags = typeof flags === "number" ? flags : Number.NaN;
          openCalls += 1;
          if (openCalls === 1) {
            expect((numericFlags & noFollowFlag) !== 0).toBe(true);
            throw createErrno("ENOTSUP");
          }
          expect(numericFlags).toBe(fs.constants.O_RDONLY);
          return fs.openSync(targetPath, flags, mode);
        },
      };

      const opened = openVerifiedFileSync({
        filePath,
        ioFs,
      });
      expect(opened.ok).toBe(true);
      expect(openCalls).toBe(2);
      if (opened.ok) {
        fs.closeSync(opened.fd);
      }
    });
  });

  it("does not mask unrelated io errors", () => {
    withTempDir("openclaw-safe-open-", (dir) => {
      const filePath = path.join(dir, "sample.txt");
      fs.writeFileSync(filePath, "ok", "utf-8");
      const ioFs = {
        ...fs,
        openSync(): number {
          throw createErrno("EACCES");
        },
      };

      const opened = openVerifiedFileSync({
        filePath,
        ioFs,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("io");
      }
    });
  });

  it("rejects directories by default", () => {
    withTempDir("openclaw-safe-open-", (root) => {
      const targetDir = path.join(root, "nested");
      fs.mkdirSync(targetDir, { recursive: true });

      const opened = openVerifiedFileSync({ filePath: targetDir });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
    });
  });
  it("keeps path classification for expected path errors", () => {
    withTempDir("openclaw-safe-open-", (dir) => {
      const filePath = path.join(dir, "sample.txt");
      fs.writeFileSync(filePath, "ok", "utf-8");
      const ioFs = {
        ...fs,
        openSync(): number {
          throw createErrno("ELOOP");
        },
      };

      const opened = openVerifiedFileSync({
        filePath,
        ioFs,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("path");
      }
    });
  });

  it("still rejects hardlinked files when rejectHardlinks=true", () => {
    if (process.platform === "win32") {
      return;
    }

    withTempDir("openclaw-safe-open-hardlink-", (dir) => {
      const sourcePath = path.join(dir, "source.txt");
      const hardlinkPath = path.join(dir, "hardlink.txt");
      fs.writeFileSync(sourcePath, "ok", "utf-8");
      fs.linkSync(sourcePath, hardlinkPath);

      const opened = openVerifiedFileSync({
        filePath: hardlinkPath,
        rejectHardlinks: true,
      });

      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
    });
  });

  it("rejects fallback open when path node changes to symlink after pre-open validation", () => {
    if (process.platform === "win32") {
      return;
    }

    withTempDir("openclaw-safe-open-race-", (dir) => {
      const filePath = path.join(dir, "sample.txt");
      const outsideDir = path.join(dir, "outside");
      const outsidePath = path.join(outsideDir, "moved.txt");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(filePath, "ok", "utf-8");

      const noFollowFlag = 0x20000000;
      let openCalls = 0;
      const ioFs = {
        ...fs,
        constants: {
          ...fs.constants,
          O_NOFOLLOW: noFollowFlag,
        },
        openSync(targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number {
          const numericFlags = typeof flags === "number" ? flags : Number.NaN;
          openCalls += 1;
          if (openCalls === 1) {
            expect((numericFlags & noFollowFlag) !== 0).toBe(true);
            throw createErrno("EINVAL");
          }
          expect(numericFlags).toBe(fs.constants.O_RDONLY);
          fs.renameSync(filePath, outsidePath);
          fs.symlinkSync(outsidePath, filePath);
          return fs.openSync(targetPath, flags, mode);
        },
      };

      const opened = openVerifiedFileSync({
        filePath,
        ioFs,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
      expect(openCalls).toBe(2);
    });
  });

  it("accepts directories when allowedType is directory", () => {
    withTempDir("openclaw-safe-open-", (root) => {
      const targetDir = path.join(root, "nested");
      fs.mkdirSync(targetDir, { recursive: true });

      const opened = openVerifiedFileSync({
        filePath: targetDir,
        allowedType: "directory",
        rejectHardlinks: true,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }
      expect(opened.stat.isDirectory()).toBe(true);
      fs.closeSync(opened.fd);
    });
  });
});
