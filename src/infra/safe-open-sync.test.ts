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

async function expectOpenFailure(params: {
  setup: (root: string) => Promise<Parameters<typeof openVerifiedFileSync>[0]>;
  expectedReason: "path" | "validation" | "io";
}): Promise<void> {
  await withTempDir("openclaw-safe-open-", async (root) => {
    const opened = openVerifiedFileSync(await params.setup(root));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe(params.expectedReason);
    }
  });
}

describe("openVerifiedFileSync", () => {
  it.each([
    {
      name: "missing files",
      expectedReason: "path" as const,
      setup: async (root: string) => ({ filePath: path.join(root, "missing.txt") }),
    },
    {
      name: "directories by default",
      expectedReason: "validation" as const,
      setup: async (root: string) => {
        const targetDir = path.join(root, "nested");
        await fsp.mkdir(targetDir, { recursive: true });
        return { filePath: targetDir };
      },
    },
    {
      name: "symlink paths when rejectPathSymlink is enabled",
      expectedReason: "validation" as const,
      setup: async (root: string) => {
        const targetFile = path.join(root, "target.txt");
        const linkFile = path.join(root, "link.txt");
        await fsp.writeFile(targetFile, "hello");
        await fsp.symlink(targetFile, linkFile);
        return {
          filePath: linkFile,
          rejectPathSymlink: true,
        };
      },
    },
    {
      name: "files larger than maxBytes",
      expectedReason: "validation" as const,
      setup: async (root: string) => {
        const filePath = path.join(root, "payload.txt");
        await fsp.writeFile(filePath, "hello");
        return {
          filePath,
          maxBytes: 4,
        };
      },
    },
  ])("fails for $name", async ({ setup, expectedReason }) => {
    await expectOpenFailure({ setup, expectedReason });
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
      ioFs,
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
      ioFs,
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("io");
    }
  });
});
