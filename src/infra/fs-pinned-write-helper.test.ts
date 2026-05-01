import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { runPinnedWriteHelper } from "./fs-pinned-write-helper.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("fs pinned write helper", () => {
  it.runIf(process.platform !== "win32")("writes through a pinned parent directory", async () => {
    const root = await tempDirs.make("openclaw-fs-pinned-root-");

    const identity = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested/deeper",
      basename: "note.txt",
      mkdir: true,
      mode: 0o600,
      input: {
        kind: "buffer",
        data: "hello",
      },
      expectedSize: 5,
    });

    await expect(
      fs.readFile(path.join(root, "nested", "deeper", "note.txt"), "utf8"),
    ).resolves.toBe("hello");
    expect(identity.dev).toBeGreaterThanOrEqual(0);
    expect(identity.ino).toBeGreaterThan(0);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink-parent writes instead of creating a temp file outside root",
    async () => {
      const root = await tempDirs.make("openclaw-fs-pinned-root-");
      const outside = await tempDirs.make("openclaw-fs-pinned-outside-");
      await fs.symlink(outside, path.join(root, "alias"));

      await expect(
        runPinnedWriteHelper({
          rootPath: root,
          relativeParentPath: "alias",
          basename: "escape.txt",
          mkdir: false,
          mode: 0o600,
          input: {
            kind: "buffer",
            data: "owned",
          },
          expectedSize: 5,
        }),
      ).rejects.toThrow();

      await expect(fs.stat(path.join(outside, "escape.txt"))).rejects.toThrow();
      const outsideFiles = await fs.readdir(outside);
      expect(outsideFiles).toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")("accepts streamed input", async () => {
    const root = await tempDirs.make("openclaw-fs-pinned-root-");
    const sourcePath = path.join(await tempDirs.make("openclaw-fs-pinned-src-"), "source.txt");
    await fs.writeFile(sourcePath, "streamed", "utf8");
    const sourceHandle = await fs.open(sourcePath, "r");
    try {
      await runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "",
        basename: "stream.txt",
        mkdir: true,
        mode: 0o600,
        input: {
          kind: "stream",
          stream: sourceHandle.createReadStream(),
        },
        expectedSize: 8,
      });
    } finally {
      await sourceHandle.close();
    }

    await expect(fs.readFile(path.join(root, "stream.txt"), "utf8")).resolves.toBe("streamed");
  });

  it.runIf(process.platform !== "win32")(
    "restores the previous file when post-rename size verification fails",
    async () => {
      const root = await tempDirs.make("openclaw-fs-pinned-root-");
      const targetPath = path.join(root, "note.txt");
      await fs.writeFile(targetPath, "keep-me", "utf8");

      await expect(
        runPinnedWriteHelper({
          rootPath: root,
          relativeParentPath: "",
          basename: "note.txt",
          mkdir: true,
          mode: 0o600,
          input: {
            kind: "buffer",
            data: "hello",
          },
          expectedSize: 99,
        }),
      ).rejects.toThrow(/write size mismatch/);

      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("keep-me");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects overwriting a symlinked destination before creating a backup",
    async () => {
      const root = await tempDirs.make("openclaw-fs-pinned-root-");
      const outside = await tempDirs.make("openclaw-fs-pinned-outside-");
      const targetPath = path.join(root, "note.txt");
      const outsidePath = path.join(outside, "secret.txt");
      await fs.writeFile(outsidePath, "outside-secret", "utf8");
      await fs.symlink(outsidePath, targetPath);

      await expect(
        runPinnedWriteHelper({
          rootPath: root,
          relativeParentPath: "",
          basename: "note.txt",
          mkdir: true,
          mode: 0o600,
          input: {
            kind: "buffer",
            data: "hello",
          },
          expectedSize: 5,
        }),
      ).rejects.toThrow();

      await expect(fs.readlink(targetPath)).resolves.toBe(outsidePath);
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside-secret");
    },
  );
});
