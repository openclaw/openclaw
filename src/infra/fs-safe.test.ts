import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createRootScopedReadFile,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  readPathWithinRoot,
  readLocalFileSafely,
  writeFileWithinRoot,
} from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("fs-safe", () => {
  it("reads a local file safely", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const file = path.join(dir, "payload.txt");
    await fs.writeFile(file, "hello");

    const result = await readLocalFileSafely({ filePath: file });
    expect(result.buffer.toString("utf8")).toBe("hello");
    expect(result.stat.size).toBe(5);
    expect(result.realPath).toContain("payload.txt");
  });

  it("rejects directories", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    await expect(readLocalFileSafely({ filePath: dir })).rejects.toMatchObject({
      code: "not-file",
    });
    const err = await readLocalFileSafely({ filePath: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeOpenError);
    expect((err as SafeOpenError).message).not.toMatch(/EISDIR/i);
  });

  it("enforces maxBytes", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const file = path.join(dir, "big.bin");
    await fs.writeFile(file, Buffer.alloc(8));

    await expect(readLocalFileSafely({ filePath: file, maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it.runIf(process.platform !== "win32")("rejects symlinks", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "link.txt");
    await fs.writeFile(target, "target");
    await fs.symlink(target, link);

    await expect(readLocalFileSafely({ filePath: link })).rejects.toMatchObject({
      code: "symlink",
    });
  });

  it("blocks traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const file = path.join(outside, "outside.txt");
    await fs.writeFile(file, "outside");

    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: path.join("..", path.basename(outside), "outside.txt"),
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it("rejects directory path within root without leaking EISDIR (issue #31186)", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      openFileWithinRoot({ rootDir: root, relativePath: "memory" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid-path|not-file/) });

    const err = await openFileWithinRoot({
      rootDir: root,
      relativePath: "memory",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeOpenError);
    expect((err as SafeOpenError).message).not.toMatch(/EISDIR/i);
  });

  it("reads a file within root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.writeFile(path.join(root, "inside.txt"), "inside");
    const result = await readFileWithinRoot({
      rootDir: root,
      relativePath: "inside.txt",
    });
    expect(result.buffer.toString("utf8")).toBe("inside");
    expect(result.realPath).toContain("inside.txt");
    expect(result.stat.size).toBe(6);
  });

  it("reads an absolute path within root via readPathWithinRoot", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const insidePath = path.join(root, "absolute.txt");
    await fs.writeFile(insidePath, "absolute");
    const result = await readPathWithinRoot({
      rootDir: root,
      filePath: insidePath,
    });
    expect(result.buffer.toString("utf8")).toBe("absolute");
  });

  it("creates a root-scoped read callback", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const insidePath = path.join(root, "scoped.txt");
    await fs.writeFile(insidePath, "scoped");
    const readScoped = createRootScopedReadFile({ rootDir: root });
    await expect(readScoped(insidePath)).resolves.toEqual(Buffer.from("scoped"));
  });

  it.runIf(process.platform !== "win32")("blocks symlink escapes under root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const target = path.join(outside, "outside.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "outside");
    await fs.symlink(target, link);

    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: "link.txt",
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it.runIf(process.platform !== "win32")("blocks hardlink aliases under root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const outsideFile = path.join(outside, "outside.txt");
    const hardlinkPath = path.join(root, "link.txt");
    await fs.writeFile(outsideFile, "outside");
    try {
      try {
        await fs.link(outsideFile, hardlinkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }
      await expect(
        openFileWithinRoot({
          rootDir: root,
          relativePath: "link.txt",
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
    } finally {
      await fs.rm(hardlinkPath, { force: true });
      await fs.rm(outsideFile, { force: true });
    }
  });

  it("writes a file within root safely", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await writeFileWithinRoot({
      rootDir: root,
      relativePath: "nested/out.txt",
      data: "hello",
    });
    await expect(fs.readFile(path.join(root, "nested", "out.txt"), "utf8")).resolves.toBe("hello");
  });

  it("rejects write traversal outside root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await expect(
      writeFileWithinRoot({
        rootDir: root,
        relativePath: "../escape.txt",
        data: "x",
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it.runIf(process.platform !== "win32")("rejects writing through hardlink aliases", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const outside = await tempDirs.make("openclaw-fs-safe-outside-");
    const outsideFile = path.join(outside, "outside.txt");
    const hardlinkPath = path.join(root, "alias.txt");
    await fs.writeFile(outsideFile, "outside");
    try {
      try {
        await fs.link(outsideFile, hardlinkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          return;
        }
        throw err;
      }
      await expect(
        writeFileWithinRoot({
          rootDir: root,
          relativePath: "alias.txt",
          data: "pwned",
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    } finally {
      await fs.rm(hardlinkPath, { force: true });
      await fs.rm(outsideFile, { force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not truncate out-of-root file when symlink retarget races write open",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const inside = path.join(root, "inside");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      await fs.mkdir(inside, { recursive: true });
      const insideTarget = path.join(inside, "target.txt");
      const outsideTarget = path.join(outside, "target.txt");
      await fs.writeFile(insideTarget, "inside");
      await fs.writeFile(outsideTarget, "X".repeat(4096));
      const slot = path.join(root, "slot");
      await fs.symlink(inside, slot);

      const realRealpath = fs.realpath.bind(fs);
      let flipped = false;
      const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        const [filePath] = args;
        if (!flipped && String(filePath).endsWith(path.join("slot", "target.txt"))) {
          flipped = true;
          await fs.rm(slot, { recursive: true, force: true });
          await fs.symlink(outside, slot);
        }
        return await realRealpath(...args);
      });
      try {
        await expect(
          writeFileWithinRoot({
            rootDir: root,
            relativePath: path.join("slot", "target.txt"),
            data: "new-content",
            mkdir: false,
          }),
        ).rejects.toMatchObject({ code: "outside-workspace" });
      } finally {
        realpathSpy.mockRestore();
      }

      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("X".repeat(4096));
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up created out-of-root file when symlink retarget races create path",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const inside = path.join(root, "inside");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      await fs.mkdir(inside, { recursive: true });
      const outsideTarget = path.join(outside, "target.txt");
      const slot = path.join(root, "slot");
      await fs.symlink(inside, slot);

      const realOpen = fs.open.bind(fs);
      let flipped = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const [filePath] = args;
        if (!flipped && String(filePath).endsWith(path.join("slot", "target.txt"))) {
          flipped = true;
          await fs.rm(slot, { recursive: true, force: true });
          await fs.symlink(outside, slot);
        }
        return await realOpen(...args);
      });
      try {
        await expect(
          writeFileWithinRoot({
            rootDir: root,
            relativePath: path.join("slot", "target.txt"),
            data: "new-content",
            mkdir: false,
          }),
        ).rejects.toMatchObject({ code: "outside-workspace" });
      } finally {
        openSpy.mockRestore();
      }

      await expect(fs.stat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("returns not-found for missing files", async () => {
    const dir = await tempDirs.make("openclaw-fs-safe-");
    const missing = path.join(dir, "missing.txt");

    await expect(readLocalFileSafely({ filePath: missing })).rejects.toBeInstanceOf(SafeOpenError);
    await expect(readLocalFileSafely({ filePath: missing })).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("tilde expansion in file tools", () => {
  it("expandHomePrefix respects process.env.HOME changes", async () => {
    const { expandHomePrefix } = await import("./home-dir.js");
    const originalHome = process.env.HOME;
    const fakeHome = "/tmp/fake-home-test";
    process.env.HOME = fakeHome;
    try {
      const result = expandHomePrefix("~/file.txt");
      expect(path.normalize(result)).toBe(path.join(path.resolve(fakeHome), "file.txt"));
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("reads a file via ~/path after HOME override", async () => {
    const root = await tempDirs.make("openclaw-tilde-test-");
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await fs.writeFile(path.join(root, "hello.txt"), "tilde-works");
      const result = await openFileWithinRoot({
        rootDir: root,
        relativePath: "~/hello.txt",
      });
      const buf = Buffer.alloc(result.stat.size);
      await result.handle.read(buf, 0, buf.length, 0);
      await result.handle.close();
      expect(buf.toString("utf8")).toBe("tilde-works");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("writes a file via ~/path after HOME override", async () => {
    const root = await tempDirs.make("openclaw-tilde-test-");
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: "~/output.txt",
        data: "tilde-write-works",
      });
      const content = await fs.readFile(path.join(root, "output.txt"), "utf8");
      expect(content).toBe("tilde-write-works");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("rejects ~/path that resolves outside root", async () => {
    const root = await tempDirs.make("openclaw-tilde-outside-");
    // HOME points to real home, ~/file goes to /home/dev/file which is outside root
    await expect(
      openFileWithinRoot({
        rootDir: root,
        relativePath: "~/escape.txt",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/outside-workspace|not-found|invalid-path/),
    });
  });
});
