import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  DirectoryWalkLimitError,
  listDirectoryTreeStrict,
  listDirectoryTreeStrictSync,
} from "./directory-walk.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each([
  ["async", listDirectoryTreeStrict],
  ["sync", listDirectoryTreeStrictSync],
] as const)("%s directory walk", (_name, walk) => {
  it("reports ancestor, external-directory, and file symlinks without traversing them", async () => {
    const root = tempDirs.make("directory-walk-");
    const outside = tempDirs.make("directory-walk-outside-");
    fs.mkdirSync(path.join(root, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(outside, "private.txt"), "not in this tree");
    fs.symlinkSync(root, path.join(root, "a/b/up"), "dir");
    fs.symlinkSync(outside, path.join(root, "external"), "dir");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(root, "file"), "file");
    fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"), "file");
    const entries = await walk(root);
    expect(entries.map((walkEntry) => walkEntry.relativePath)).toEqual(
      ["a", "a/b", "a/b/up", "dangling", "external", "file"].map((p) =>
        p.split("/").join(path.sep),
      ),
    );
    expect(
      entries
        .filter(({ dirent }) => dirent.isSymbolicLink())
        .map((walkEntry) => walkEntry.relativePath),
    ).toEqual(["a/b/up", "dangling", "external", "file"].map((p) => p.split("/").join(path.sep)));
    expect(entries.some(({ dirent }) => dirent.isFile())).toBe(false);
  });

  it("returns deterministic relative paths and types matching a plain recursive listing", async () => {
    const root = tempDirs.make("directory-walk-");
    fs.mkdirSync(path.join(root, "z/empty"), { recursive: true });
    fs.writeFileSync(path.join(root, "z/child.txt"), "child");
    fs.writeFileSync(path.join(root, "a.txt"), "root");
    const entries = await walk(root);
    expect(entries.map((walkEntry) => walkEntry.relativePath)).toEqual(
      ["a.txt", "z", "z/child.txt", "z/empty"].map((p) => p.split("/").join(path.sep)),
    );
    // Deliberately link-free compatibility fixture; never run this on a checkout.
    expect(entries.map((walkEntry) => walkEntry.relativePath)).toEqual(
      // oxlint-disable-next-line openclaw-boundaries/no-recursive-readdir -- Independent compatibility oracle on this explicitly link-free fixture only.
      fs.readdirSync(root, { recursive: true }).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(entries.map(({ dirent }) => dirent.isFile())).toEqual([true, false, true, false]);
  });

  it.each([
    [{ maxEntries: 1 }, "maxEntries", 1],
    [{ maxDepth: 1 }, "maxDepth", 1],
  ] as const)(
    "throws a typed error rather than truncating at %j",
    async (options, limit, maximum) => {
      const root = tempDirs.make("directory-walk-");
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "nested/file"), "child");
      const result = Promise.resolve().then(() => walk(root, options));
      await expect(result).rejects.toMatchObject({
        name: "DirectoryWalkLimitError",
        code: "ERR_DIRECTORY_WALK_LIMIT",
        limit,
        maximum,
      });
      await expect(result).rejects.toBeInstanceOf(DirectoryWalkLimitError);
      expect(await walk(root, { maxEntries: 2, maxDepth: 2 })).toHaveLength(2);
    },
  );

  it("accepts an empty directory exactly at the depth limit", async () => {
    const root = tempDirs.make("directory-walk-depth-");
    fs.mkdirSync(path.join(root, "leaf"));
    expect((await walk(root, { maxDepth: 1 })).map((entry) => entry.relativePath)).toEqual([
      "leaf",
    ]);
    fs.writeFileSync(path.join(root, "leaf/over-limit"), "child");
    await expect(Promise.resolve().then(() => walk(root, { maxDepth: 1 }))).rejects.toMatchObject({
      code: "ERR_DIRECTORY_WALK_LIMIT",
      limit: "maxDepth",
      maximum: 1,
    });
  });

  it("bounds a wide directory before accumulating the entire inventory", async () => {
    const root = tempDirs.make("directory-walk-wide-");
    for (let index = 0; index < 128; index++) {
      fs.writeFileSync(path.join(root, String(index)), "");
    }
    // Prove streaming admission: bulk enumeration must not precede the budget check.
    const syncRead = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("bulk enumeration");
    });
    const asyncRead = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValue(new Error("bulk enumeration"));
    try {
      await expect(
        Promise.resolve().then(() => walk(root, { maxEntries: 3 })),
      ).rejects.toMatchObject({
        code: "ERR_DIRECTORY_WALK_LIMIT",
        limit: "maxEntries",
        maximum: 3,
      });
    } finally {
      syncRead.mockRestore();
      asyncRead.mockRestore();
    }
    expect(await walk(root, { maxEntries: 128 })).toHaveLength(128);
  });

  it("prunes directory contents before consuming depth or entry budgets", async () => {
    const root = tempDirs.make("directory-walk-pruned-");
    fs.mkdirSync(path.join(root, "ignored/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "ignored/deep/file"), "ignored");
    fs.writeFileSync(path.join(root, "kept"), "visible");
    const entries = await walk(root, {
      maxDepth: 1,
      maxEntries: 2,
      skipDirectory: ({ dirent }) => dirent.name === "ignored",
    });
    expect(entries.map((entry) => entry.relativePath)).toEqual(["ignored", "kept"]);
  });

  it("allows an empty root at zero budgets and rejects invalid budgets", async () => {
    const root = tempDirs.make("directory-walk-");
    expect(await walk(root, { maxDepth: 0, maxEntries: 0 })).toEqual([]);
    for (const options of [{ maxDepth: -1 }, { maxEntries: Infinity }, { maxDepth: 0.5 }]) {
      await expect(Promise.resolve().then(() => walk(root, options))).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it("preserves missing/non-directory errors and rejects a symlink root", async () => {
    const root = tempDirs.make("directory-walk-");
    fs.writeFileSync(path.join(root, "file"), "file");
    fs.symlinkSync(root, path.join(root, "link"), "dir");
    await expect(
      Promise.resolve().then(() => walk(path.join(root, "absent"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(Promise.resolve().then(() => walk(path.join(root, "file")))).rejects.toMatchObject(
      { code: "ENOTDIR" },
    );
    await expect(Promise.resolve().then(() => walk(path.join(root, "link")))).rejects.toMatchObject(
      {
        code: "ERR_DIRECTORY_WALK_ROOT_SYMLINK",
      },
    );
  });
});
