import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { openPinnedFileSync } from "./safe-open-sync.js";

type PinnedOpenSyncFs = NonNullable<Parameters<typeof openPinnedFileSync>[0]["ioFs"]>;
type PinnedOpenSyncLstatSync = PinnedOpenSyncFs["lstatSync"];
type PinnedOpenSyncRealpathSync = PinnedOpenSyncFs["realpathSync"];
type PinnedOpenSyncFstatSync = PinnedOpenSyncFs["fstatSync"];

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

function mockRealpathSync(result: string): PinnedOpenSyncRealpathSync {
  const resolvePath = ((_: fs.PathLike) => result) as PinnedOpenSyncRealpathSync;
  resolvePath.native = ((_: fs.PathLike) => result) as typeof resolvePath.native;
  return resolvePath;
}

function mockLstatSync(read: (filePath: fs.PathLike) => fs.Stats): PinnedOpenSyncLstatSync {
  return ((filePath: fs.PathLike) => read(filePath)) as unknown as PinnedOpenSyncLstatSync;
}

function mockFstatSync(stat: fs.Stats): PinnedOpenSyncFstatSync {
  return ((_: number) => stat) as unknown as PinnedOpenSyncFstatSync;
}

async function expectOpenFailure(params: {
  setup: (root: string) => Promise<Parameters<typeof openPinnedFileSync>[0]>;
  expectedReason: "path" | "validation" | "io";
}): Promise<void> {
  await withTempDir({ prefix: "openclaw-safe-open-" }, async (root) => {
    const opened = openPinnedFileSync(await params.setup(root));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe(params.expectedReason);
    }
  });
}

function expectOpenReason(
  opened: ReturnType<typeof openPinnedFileSync>,
  expectedReason: "path" | "validation" | "io",
): void {
  expect(opened.ok).toBe(false);
  if (opened.ok) {
    return;
  }
  expect(opened.reason).toBe(expectedReason);
}

describe("openPinnedFileSync", () => {
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
    await withTempDir({ prefix: "openclaw-safe-open-" }, async (root) => {
      const targetDir = path.join(root, "nested");
      await fsp.mkdir(targetDir, { recursive: true });

      const opened = openPinnedFileSync({
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
    const ioFs: PinnedOpenSyncFs = {
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

    const opened = openPinnedFileSync({
      filePath: "/input/file.txt",
      ioFs,
    });
    expectOpenReason(opened, "validation");
    expect(closed).toEqual([42]);
  });

  it("reports non-path filesystem failures as io errors", () => {
    const ioFs: PinnedOpenSyncFs = {
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

    const opened = openPinnedFileSync({
      filePath: "/input/file.txt",
      rejectPathSymlink: true,
      ioFs,
    });
    expectOpenReason(opened, "io");
  });
});
