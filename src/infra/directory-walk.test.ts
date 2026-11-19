import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  DirectoryWalkLimitError,
  type DirectoryWalkEntry,
  listDirectoryTreeStrict,
  listDirectoryTreeStrictSync,
} from "./directory-walk.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nativePaths = (paths: string[]) => paths.map((p) => p.split("/").join(path.sep));
const paths = (entries: DirectoryWalkEntry[]) => entries.map((entry) => entry.relativePath);
function tree(...entries: string[]) {
  const root = tempDirs.make("directory-walk-");
  for (const entry of entries) {
    const target = path.join(root, entry);
    fs.mkdirSync(entry.endsWith("/") ? target : path.dirname(target), { recursive: true });
    if (!entry.endsWith("/")) {
      fs.writeFileSync(target, "fixture");
    }
  }
  return root;
}

describe.each([
  ["async", listDirectoryTreeStrict],
  ["sync", listDirectoryTreeStrictSync],
] as const)("%s directory walk", (_name, walk) => {
  const run = (root: string, options?: Parameters<typeof walk>[1]) =>
    Promise.resolve().then(() => walk(root, options));
  const limitError = (limit: string, maximum: number) => ({
    name: "DirectoryWalkLimitError",
    code: "ERR_DIRECTORY_WALK_LIMIT",
    limit,
    maximum,
  });
  it("reports ancestor, external-directory, and file symlinks without traversing them", async () => {
    const root = tree("a/b/");
    const outside = tree("private.txt");
    fs.symlinkSync(root, path.join(root, "a/b/up"), "dir");
    fs.symlinkSync(outside, path.join(root, "external"), "dir");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(root, "file"), "file");
    fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"), "file");
    const entries = await walk(root);
    expect(paths(entries)).toEqual(
      nativePaths(["a", "a/b", "a/b/up", "dangling", "external", "file"]),
    );
    expect(paths(entries.filter(({ dirent }) => dirent.isSymbolicLink()))).toEqual(
      nativePaths(["a/b/up", "dangling", "external", "file"]),
    );
    expect(entries.some(({ dirent }) => dirent.isFile())).toBe(false);
  });

  it("returns deterministic relative paths and types", async () => {
    const root = tree("z/empty/", "z/child.txt", "a.txt");
    const entries = await walk(root);
    expect(paths(entries)).toEqual(nativePaths(["a.txt", "z", "z/child.txt", "z/empty"]));
    expect(entries.map(({ dirent }) => dirent.isFile())).toEqual([true, false, true, false]);
  });

  it("accepts an empty directory exactly at the depth limit", async () => {
    const root = tree("leaf/");
    expect(paths(await walk(root, { maxDepth: 1 }))).toEqual(["leaf"]);
    fs.writeFileSync(path.join(root, "leaf/over-limit"), "child");
    const overLimit = run(root, { maxDepth: 1 });
    await expect(overLimit).rejects.toMatchObject(limitError("maxDepth", 1));
    await expect(overLimit).rejects.toBeInstanceOf(DirectoryWalkLimitError);
    expect(await walk(root, { maxEntries: 2, maxDepth: 2 })).toHaveLength(2);
  });

  it("bounds a wide directory before accumulating the entire inventory", async () => {
    const root = tree(...Array.from({ length: 128 }, (_, index) => String(index)));
    // Prove streaming admission: bulk enumeration must not precede the budget check.
    const syncRead = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("bulk enumeration");
    });
    const asyncRead = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValue(new Error("bulk enumeration"));
    try {
      await expect(run(root, { maxEntries: 3 })).rejects.toMatchObject(limitError("maxEntries", 3));
    } finally {
      syncRead.mockRestore();
      asyncRead.mockRestore();
    }
    expect(await walk(root, { maxEntries: 128 })).toHaveLength(128);
  });

  it("prunes directory contents before consuming depth or entry budgets", async () => {
    const root = tree("ignored/deep/file", "kept");
    const entries = await walk(root, {
      maxDepth: 1,
      maxEntries: 2,
      skipDirectory: ({ dirent }) => dirent.name === "ignored",
    });
    expect(paths(entries)).toEqual(["ignored", "kept"]);
  });

  it("allows an empty root at zero budgets and rejects invalid budgets", async () => {
    const root = tree();
    expect(await walk(root, { maxDepth: 0, maxEntries: 0 })).toEqual([]);
    for (const options of [{ maxDepth: -1 }, { maxEntries: Infinity }, { maxDepth: 0.5 }]) {
      await expect(run(root, options)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("preserves missing/non-directory errors and rejects a symlink root", async () => {
    const root = tree("file");
    fs.symlinkSync(root, path.join(root, "link"), "dir");
    for (const [entry, code] of [
      ["absent", "ENOENT"],
      ["file", "ENOTDIR"],
      ["link", "ERR_DIRECTORY_WALK_ROOT_SYMLINK"],
    ] as const) {
      await expect(run(path.join(root, entry))).rejects.toMatchObject({ code });
    }
  });
});
