import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openVerifiedFileSync } from "./safe-open-sync.js";

type SafeOpenSyncFs = NonNullable<Parameters<typeof openVerifiedFileSync>[0]["ioFs"]>;
type SafeOpenSyncLstatSync = SafeOpenSyncFs["lstatSync"];
type SafeOpenSyncRealpathSync = SafeOpenSyncFs["realpathSync"];
type SafeOpenSyncFstatSync = SafeOpenSyncFs["fstatSync"];

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function mockStat(params: {
  isFile?: boolean;
  isDirectory?: boolean;
  nlink?: number;
  size?: number;
  dev?: number;
  ino?: number;
}): fs.Stats {
  return {
    isFile: () => params.isFile ?? false,
    isDirectory: () => params.isDirectory ?? false,
    isSymbolicLink: () => false,
    nlink: params.nlink ?? 1,
    size: params.size ?? 0,
    dev: params.dev ?? 1,
    ino: params.ino ?? 1,
  } as unknown as fs.Stats;
}

function mockRealpathSync(result: string): SafeOpenSyncRealpathSync {
  const resolvePath = ((_: fs.PathLike) => result) as SafeOpenSyncRealpathSync;
  resolvePath.native = ((_: fs.PathLike) => result) as typeof resolvePath.native;
  return resolvePath;
}

function mockLstatSync(read: (filePath: fs.PathLike) => fs.Stats): SafeOpenSyncLstatSync {
  return ((filePath: fs.PathLike) => read(filePath)) as unknown as SafeOpenSyncLstatSync;
}

function mockFstatSync(stat: fs.Stats): SafeOpenSyncFstatSync {
  return ((_: number) => stat) as unknown as SafeOpenSyncFstatSync;
}

describe("openVerifiedFileSync", () => {
  it("returns a path error for missing files", async () => {
    await withTempDir("openclaw-safe-open-", async (root) => {
      const opened = openVerifiedFileSync({ filePath: path.join(root, "missing.txt") });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("path");
      }
    });
  });

  it("rejects directories by default", async () => {
    await withTempDir("openclaw-safe-open-", async (root) => {
      const targetDir = path.join(root, "nested");
      await fsp.mkdir(targetDir, { recursive: true });

      const opened = openVerifiedFileSync({ filePath: targetDir });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
    });
  });

  it("accepts directories when allowedType is directory", async () => {
    await withTempDir("openclaw-safe-open-", async (root) => {
      const targetDir = path.join(root, "nested");
      await fsp.mkdir(targetDir, { recursive: true });

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

  it("rejects symlink paths when rejectPathSymlink is enabled", async () => {
    await withTempDir("openclaw-safe-open-", async (root) => {
      const targetFile = path.join(root, "target.txt");
      const linkFile = path.join(root, "link.txt");
      await fsp.writeFile(targetFile, "hello");
      await fsp.symlink(targetFile, linkFile);

      const opened = openVerifiedFileSync({
        filePath: linkFile,
        rejectPathSymlink: true,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
    });
  });

  it("rejects files larger than maxBytes", async () => {
    await withTempDir("openclaw-safe-open-", async (root) => {
      const filePath = path.join(root, "payload.txt");
      await fsp.writeFile(filePath, "hello");

      const opened = openVerifiedFileSync({
        filePath,
        maxBytes: 4,
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.reason).toBe("validation");
      }
    });
  });

  it("rejects post-open validation mismatches and closes the fd", () => {
    const closeSync = (fd: number) => {
      closed.push(fd);
    };
    const closed: number[] = [];
    const ioFs: SafeOpenSyncFs = {
      constants: fs.constants,
      lstatSync: mockLstatSync((filePath) =>
        String(filePath) === "/real/file.txt"
          ? mockStat({ isFile: true, size: 1, dev: 1, ino: 1 })
          : mockStat({ isFile: false }),
      ),
      realpathSync: mockRealpathSync("/real/file.txt"),
      openSync: () => 42,
      fstatSync: mockFstatSync(mockStat({ isFile: true, size: 1, dev: 2, ino: 1 })),
      closeSync,
    };

    const opened = openVerifiedFileSync({
      filePath: "/input/file.txt",
      ioFs: ioFs as unknown as SafeOpenSyncFs,
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("validation");
    }
    expect(closed).toEqual([42]);
  });

  it("reports non-path filesystem failures as io errors", () => {
    const ioFs: SafeOpenSyncFs = {
      constants: fs.constants,
      lstatSync: () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      realpathSync: mockRealpathSync("/real/file.txt"),
      openSync: () => 42,
      fstatSync: mockFstatSync(mockStat({ isFile: true })),
      closeSync: () => {},
    };

    const opened = openVerifiedFileSync({
      filePath: "/input/file.txt",
      rejectPathSymlink: true,
      ioFs: ioFs as unknown as SafeOpenSyncFs,
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("io");
    }
  });
});
