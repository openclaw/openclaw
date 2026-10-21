// Tests safe filesystem wrappers and protected file-handle behavior.
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  resolveOpenedFileRealPathForHandle,
  FsSafeError,
  readLocalFileSafely,
  root as openRoot,
  writeExternalFileWithinRoot,
} from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

async function expectRejectCode(promise: Promise<unknown>, expected: string | RegExp) {
  const err = await promise.catch((caught: unknown) => caught);
  if (err === undefined) {
    throw new Error("Expected promise to reject");
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof expected === "string") {
    expect(code).toBe(expected);
  } else {
    expect(code).toMatch(expected);
  }
}

async function makeFile(name: string, data: string | Buffer) {
  return path.join(await makeRoot({ [name]: data }), name);
}

async function makeRoot(files: Record<string, string | Buffer> = {}) {
  const root = await tempDirs.make("openclaw-fs-safe-");
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  return root;
}

async function expectContents(file: string, contents: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
}

async function aliasRoot() {
  const root = await makeRoot();
  const realDir = path.join(root, "real");
  await fs.mkdir(realDir);
  await fs.symlink(realDir, path.join(root, "alias"));
  return { root, realDir };
}

async function runSymlinkWriteRace(
  runWrite: (root: Awaited<ReturnType<typeof openRoot>>, relativePath: string) => Promise<void>,
  seedInsideTarget = true,
): Promise<void> {
  const { root, slot, outside, outsideTarget } = await setupSymlinkWriteRaceFixture({
    seedInsideTarget,
  });
  await withRealpathSymlinkRebindRace({
    realpathApi: "native-sync",
    shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot", "target.txt")),
    symlinkPath: slot,
    symlinkTarget: outside,
    timing: "before-realpath",
    run: async () => {
      try {
        await runWrite(await openRoot(root), path.join("slot", "target.txt"));
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toMatch(
          /outside-workspace|path-mismatch|path-alias|invalid-path|not-file/,
        );
      }
    },
  });
  await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
}

async function withOutsideHardlinkAlias(params: {
  aliasPath: string;
  run: (outsideFile: string) => Promise<void>;
}): Promise<void> {
  const outside = await tempDirs.make("openclaw-fs-safe-outside-");
  const outsideFile = path.join(outside, "outside.txt");
  await fs.writeFile(outsideFile, "outside");
  try {
    try {
      await fs.link(outsideFile, params.aliasPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }
    await params.run(outsideFile);
  } finally {
    await fs.rm(params.aliasPath, { force: true });
    await fs.rm(outsideFile, { force: true });
  }
}

async function setupSymlinkWriteRaceFixture(options?: { seedInsideTarget?: boolean }) {
  const root = await tempDirs.make("openclaw-fs-safe-root-");
  const inside = path.join(root, "inside");
  const outside = await tempDirs.make("openclaw-fs-safe-outside-");
  await fs.mkdir(inside, { recursive: true });
  if (options?.seedInsideTarget) {
    await fs.writeFile(path.join(inside, "target.txt"), "inside");
  }
  const outsideTarget = path.join(outside, "target.txt");
  await fs.writeFile(outsideTarget, "X".repeat(4096));
  const slot = path.join(root, "slot");
  await createRebindableDirectoryAlias({
    aliasPath: slot,
    targetPath: inside,
  });
  return { root, outside, slot, outsideTarget };
}

describe("fs-safe", () => {
  it("reads a local file safely", async () => {
    const file = await makeFile("payload.txt", "hello");

    const result = await readLocalFileSafely({ filePath: file });
    expect(result.buffer.toString("utf8")).toBe("hello");
    expect(result.stat.size).toBe(5);
    expect(result.realPath).toContain("payload.txt");
  });

  it("rejects directories", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    await expectRejectCode(readLocalFileSafely({ filePath: dir }), "not-file");
    const err = await readLocalFileSafely({ filePath: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsSafeError);
    expect((err as FsSafeError).message).not.toMatch(/EISDIR/i);
  });

  it("cleans partial external command output when the producer fails", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-output-failure-");
    const failure = new Error("external producer failed");

    await expect(
      writeExternalFileWithinRoot({
        rootDir: dir,
        path: "artifact.txt",
        write: async (tempPath) => {
          await fs.writeFile(tempPath, "partial artifact");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it.each([
    ["default", {}, "artifact.txt", "artifact.txt"],
    ["fallbackFileName", { fallbackFileName: "safe-output.bin" }, "\u0001", "safe-output.bin"],
    ["tempPrefix", { tempPrefix: "safe-output.bin" }, "\u0001", "safe-output.bin"],
  ] as const)(
    "publishes external output using %s naming",
    async (_label, naming, requested, name) => {
      const dir = await tempDirs.make("openclaw-fs-safe-output-name-");

      const result = await writeExternalFileWithinRoot({
        rootDir: dir,
        path: requested,
        ...naming,
        write: async (tempPath) => {
          await fs.writeFile(tempPath, "artifact");
        },
      });

      expect(result).toEqual({ path: path.join(dir, name) });
      await expectContents(result.path, "artifact");
    },
  );

  it("enforces maxBytes", async () => {
    const file = await makeFile("big.bin", Buffer.alloc(8));

    await expectRejectCode(readLocalFileSafely({ filePath: file, maxBytes: 4 }), "too-large");
  });

  it.runIf(process.platform !== "win32").each(["local", "root"] as const)(
    "rejects symlinks through %s reads",
    async (method) => {
      const dir = await tempDirs.make("openclaw-fs-safe-");
      const target = await makeFile("target.txt", "outside");
      const link = path.join(dir, "link.txt");
      await fs.symlink(target, link);
      await expectRejectCode(
        method === "local"
          ? readLocalFileSafely({ filePath: link })
          : (await openRoot(dir)).open("link.txt"),
        "symlink",
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["moved", "unresolved"] as const)(
    "resolves opened file real paths with a %s fd target",
    async (mode) => {
      const filePath = await makeFile("inside.txt", "inside");
      const movedPath = path.join(path.dirname(filePath), "moved.txt");
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async (target) =>
        typeof target === "string" && target.startsWith("/dev/fd/")
          ? mode === "moved"
            ? movedPath
            : "/dev/fd/inside.txt"
          : await realpath(target),
      );
      const handle = await fs.open(filePath, "r");
      try {
        if (mode === "moved") {
          await fs.rename(filePath, movedPath);
          await fs.symlink(await makeFile("outside.txt", "outside"), filePath);
        }
        await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).resolves.toBe(
          mode === "moved" ? movedPath : await realpath(filePath),
        );
        if (mode === "moved") {
          await expect(handle.readFile({ encoding: "utf8" })).resolves.toBe("inside");
        }
      } finally {
        await handle.close().catch(() => {});
      }
    },
  );

  it("blocks traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const file = path.join(outside, "outside.txt");
    await fs.writeFile(file, "outside");

    await expectRejectCode(
      (await openRoot(root)).open(path.join("..", path.basename(outside), "outside.txt")),
      "outside-workspace",
    );
  });

  it("rejects directory path within root without leaking EISDIR (issue #31186)", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    const rootFs = await openRoot(root);
    await expectRejectCode(rootFs.open("memory"), /invalid-path|not-file/);

    const err = await rootFs.open("memory").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsSafeError);
    expect((err as FsSafeError).message).not.toMatch(/EISDIR/i);
  });

  it("reads files within root through all read helpers", async () => {
    const root = await makeRoot({
      "inside.txt": "inside",
      "absolute.txt": "absolute",
      "scoped.txt": "scoped",
    });
    const rootFs = await openRoot(root);
    const byRelativePath = await rootFs.read("inside.txt");
    expect(byRelativePath.buffer.toString("utf8")).toBe("inside");
    expect(byRelativePath.realPath).toContain("inside.txt");
    expect(byRelativePath.stat.size).toBe(6);

    const absolutePath = path.join(root, "absolute.txt");
    const byAbsolutePath = await rootFs.readAbsolute(absolutePath);
    expect(byAbsolutePath.buffer.toString("utf8")).toBe("absolute");

    const scopedPath = path.join(root, "scoped.txt");
    const readScoped = rootFs.reader();
    await expect(readScoped(scopedPath)).resolves.toEqual(Buffer.from("scoped"));
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-target reads when the path target changes after open",
    async () => {
      const root = await makeRoot({ "inside-a.txt": "inside-a", "inside-b.txt": "inside-b" });
      const insideA = path.join(root, "inside-a.txt");
      const insideB = path.join(root, "inside-b.txt");
      const link = path.join(root, "link.txt");
      await fs.symlink(insideA, link);

      __setFsSafeTestHooksForTest({
        afterOpen: async () => {
          await fs.rm(link);
          await fs.symlink(insideB, link);
        },
      });

      await expectRejectCode(
        (await openRoot(root)).read("link.txt", {
          symlinks: "follow-within-root",
        }),
        "path-mismatch",
      );
    },
  );

  it("closes the opened handle when afterOpen hook throws", async () => {
    const root = await makeRoot({ "inside.txt": "inside" });

    let openedHandle: FileHandle | undefined;
    __setFsSafeTestHooksForTest({
      afterOpen: (_target, handle) => {
        openedHandle = handle;
        throw new Error("after-open boom");
      },
    });

    await expect((await openRoot(root)).open("inside.txt")).rejects.toThrow("after-open boom");
    if (openedHandle === undefined) {
      throw new Error("expected opened file handle");
    }
    await expectRejectCode(openedHandle.readFile({ encoding: "utf8" }), "EBADF");
  });

  it("rejects setting fs-safe test hooks outside test mode", () => {
    withEnv({ NODE_ENV: "production", VITEST: undefined }, () => {
      expect(() =>
        __setFsSafeTestHooksForTest({
          afterPreOpenLstat: () => {},
        }),
      ).toThrow("__setFsSafeTestHooksForTest is only available in tests");
    });
  });

  it.runIf(process.platform !== "win32")("blocks hardlink aliases under root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const hardlinkPath = path.join(root, "link.txt");
    await withOutsideHardlinkAlias({
      aliasPath: hardlinkPath,
      run: async () => {
        await expectRejectCode((await openRoot(root)).open("link.txt"), "hardlink");
      },
    });
  });

  it("writes a file within root safely", async () => {
    const root = await makeRoot();
    await (await openRoot(root)).write("nested/out.txt", "hello");
    await expectContents(path.join(root, "nested/out.txt"), "hello");
  });

  it("appends to a file within root safely", async () => {
    const root = await makeRoot({ "nested/out.txt": "seed" });
    const targetPath = path.join(root, "nested", "out.txt");
    await (await openRoot(root)).append("nested/out.txt", "next", { prependNewlineIfNeeded: true });
    await expectContents(targetPath, "seed\nnext");
  });

  it("copies a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const sourcePath = await makeFile("in.txt", "copy-ok");

    await (await openRoot(root)).copyIn("nested/copied.txt", sourcePath);

    await expectContents(path.join(root, "nested/copied.txt"), "copy-ok");
  });

  it("removes a file within root safely", async () => {
    const root = await makeRoot({ "nested/out.txt": "hello" });
    const targetPath = path.join(root, "nested", "out.txt");

    await (await openRoot(root)).remove("nested/out.txt");

    await expectRejectCode(fs.stat(targetPath), "ENOENT");
  });

  it("creates directories within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");

    await (await openRoot(root)).mkdir("nested/deeper");

    const stat = await fs.stat(path.join(root, "nested", "deeper"));
    expect(stat.isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "creates directories through in-root symlink parents",
    async () => {
      const { root, realDir } = await aliasRoot();

      await (await openRoot(root)).mkdir(path.join("alias", "nested", "deeper"));

      const stat = await fs.stat(path.join(realDir, "nested", "deeper"));
      expect(stat.isDirectory()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes files through in-root symlink parents",
    async () => {
      const { root, realDir } = await aliasRoot();
      await fs.writeFile(path.join(realDir, "target.txt"), "hello");

      await (await openRoot(root)).remove(path.join("alias", "target.txt"));

      await expectRejectCode(fs.stat(path.join(realDir, "target.txt")), "ENOENT");
    },
  );

  it("enforces maxBytes when copying into root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const sourcePath = await makeFile("big.bin", Buffer.alloc(8));

    await expectRejectCode(
      (await openRoot(root)).copyIn("nested/big.bin", sourcePath, {
        maxBytes: 4,
      }),
      "too-large",
    );
    await expectRejectCode(fs.stat(path.join(root, "nested", "big.bin")), "ENOENT");
  });

  it("rejects write traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await expectRejectCode((await openRoot(root)).write("../escape.txt", "x"), "outside-workspace");
  });

  it.runIf(process.platform !== "win32").each(["write", "append"] as const)(
    "rejects %s through hardlink aliases",
    async (operation) => {
      const root = await makeRoot();
      await withOutsideHardlinkAlias({
        aliasPath: path.join(root, "alias.txt"),
        run: async (outsideFile) => {
          const rootFs = await openRoot(root);
          await expectRejectCode(
            operation === "write"
              ? rootFs.write("alias.txt", "pwned")
              : rootFs.append("alias.txt", "pwned", { prependNewlineIfNeeded: true }),
            "path-alias",
          );
          await expectContents(outsideFile, "outside");
        },
      });
    },
  );

  it.each(["write", "append", "copyIn"] as const)(
    "does not clobber an out-of-root file when symlink retarget races %s",
    async (operation) => {
      const data =
        operation === "copyIn" ? await makeFile("source.txt", "new-content") : "new-content";
      await runSymlinkWriteRace(
        (root, relativePath) =>
          operation === "append"
            ? root.append(relativePath, data, { mkdir: false, prependNewlineIfNeeded: true })
            : root[operation](relativePath, data, { mkdir: false }),
        operation !== "copyIn",
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["remove", "mkdir"] as const)(
    "does not mutate outside the root when symlink retarget races %s",
    async (operation) => {
      const { root, outside, slot, outsideTarget } = await setupSymlinkWriteRaceFixture({
        seedInsideTarget: operation === "remove",
      });

      await withRealpathSymlinkRebindRace({
        realpathApi: "native-sync",
        shouldFlip: (realpathInput) => realpathInput.endsWith(path.join("slot")),
        symlinkPath: slot,
        symlinkTarget: outside,
        timing: "before-realpath",
        run: async () => {
          const rootFs = await openRoot(root);
          await expectRejectCode(
            operation === "remove"
              ? rootFs.remove(path.join("slot", "target.txt"))
              : rootFs.mkdir(path.join("slot", "nested", "deep")),
            operation === "remove" ? /path-alias|not-found/ : "path-alias",
          );
        },
      });
      if (operation === "remove") {
        await expectContents(outsideTarget, "X".repeat(4096));
      } else {
        await expectRejectCode(fs.stat(path.join(outside, "nested")), "ENOENT");
      }
    },
  );

  it("returns not-found for missing files", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const missing = path.join(dir, "missing.txt");

    await expect(readLocalFileSafely({ filePath: missing })).rejects.toBeInstanceOf(FsSafeError);
    await expectRejectCode(readLocalFileSafely({ filePath: missing }), "not-found");
  });
});

describe("tilde expansion in file tools", () => {
  it("keeps tilde expansion behavior aligned", async () => {
    const { expandHomePrefix } = await import("./home-dir.js");
    const fakeHome = path.resolve(path.sep, "tmp", "fake-home-test");

    withEnv({ HOME: fakeHome, OPENCLAW_HOME: fakeHome }, () => {
      const result = expandHomePrefix("~/file.txt");
      expect(path.normalize(result)).toBe(path.join(fakeHome, "file.txt"));
    });

    const root = await tempDirs.make("openclaw-tilde-test-");
    await withEnvAsync({ HOME: root, OPENCLAW_HOME: root }, async () => {
      await fs.writeFile(path.join(root, "hello.txt"), "tilde-works");
      const rootFs = await openRoot(root);
      const result = await rootFs.open("~/hello.txt");
      const buf = Buffer.alloc(result.stat.size);
      await result.handle.read(buf, 0, buf.length, 0);
      await result.handle.close();
      expect(buf.toString("utf8")).toBe("tilde-works");

      await rootFs.write("~/output.txt", "tilde-write-works");
      const content = await fs.readFile(path.join(root, "output.txt"), "utf8");
      expect(content).toBe("tilde-write-works");
    });

    const outsideRoot = await tempDirs.make("openclaw-tilde-outside-");
    await expectRejectCode(
      (await openRoot(outsideRoot)).open("~/escape.txt"),
      /outside-workspace|not-found|invalid-path/,
    );
  });
});
