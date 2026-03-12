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
      });
    } finally {
      await sourceHandle.close();
    }

    await expect(fs.readFile(path.join(root, "stream.txt"), "utf8")).resolves.toBe("streamed");
  });
});
