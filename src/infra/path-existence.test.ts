import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  canAccess,
  canAccessSync,
  executableFileExists,
  executableFileExistsSync,
  lstatIfExists,
  pathEntryExists,
  pathMayExistSync,
  readDirectoryEntriesSync,
  safeStat,
} from "./path-existence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filesystem discovery policies", () => {
  it("distinguishes entries from followed targets and returns typed directory entries", async () => {
    await withTestDir({ prefix: "openclaw-path-guards-" }, async (root) => {
      const file = path.join(root, "file");
      const directory = path.join(root, "directory");
      const link = path.join(root, "link");
      const dangling = path.join(root, "dangling");
      const missing = path.join(root, "missing");
      await fsPromises.writeFile(file, "fixture");
      await fsPromises.mkdir(directory);
      await fsPromises.symlink(file, link, "file");
      await fsPromises.symlink(missing, dangling, "file");

      expect(await pathEntryExists(dangling)).toBe(true);
      expect(await pathEntryExists(missing)).toBe(false);
      expect((await lstatIfExists(dangling))?.isSymbolicLink()).toBe(true);
      expect(await lstatIfExists(missing)).toBeUndefined();
      expect(await lstatIfExists(path.join(file, "child"))).toBeUndefined();
      await expect(lstatIfExists(path.join(file, "child"), "ENOENT")).rejects.toMatchObject({
        code: "ENOTDIR",
      });
      expect((await safeStat(link))?.isFile()).toBe(true);
      expect((await safeStat(directory))?.isDirectory()).toBe(true);
      expect(await safeStat(dangling)).toBeNull();
      expect(await safeStat(missing)).toBeNull();
      const entries = readDirectoryEntriesSync(root);
      expect(entries.map((entry) => entry.name).toSorted()).toEqual([
        "dangling",
        "directory",
        "file",
        "link",
      ]);
      expect(entries.find((entry) => entry.name === "directory")?.isDirectory()).toBe(true);
      expect(readDirectoryEntriesSync(missing)).toEqual([]);
      expect(readDirectoryEntriesSync(file)).toEqual([]);
    });
  });

  it("uses the requested access mode instead of substituting an existence check", async () => {
    await withTestDir({ prefix: "openclaw-access-" }, async (root) => {
      const file = path.join(root, "file");
      const missing = path.join(root, "missing");
      await fsPromises.writeFile(file, "fixture", { mode: 0o600 });
      expect(await canAccess(file, fs.constants.R_OK)).toBe(true);
      expect(canAccessSync(file, fs.constants.R_OK)).toBe(true);
      expect(await canAccess(missing)).toBe(false);
      expect(canAccessSync(missing)).toBe(false);
      if (process.platform !== "win32") {
        expect(await canAccess(file, fs.constants.X_OK)).toBe(false);
        expect(canAccessSync(file, fs.constants.X_OK)).toBe(false);
        await fsPromises.chmod(file, 0o700);
        expect(await canAccess(file, fs.constants.X_OK)).toBe(true);
        expect(canAccessSync(file, fs.constants.X_OK)).toBe(true);
      }
    });
  });

  it("propagates non-ENOENT entry failures rather than reporting absence", async () => {
    const failure = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    vi.spyOn(fsPromises, "lstat").mockRejectedValue(failure);
    await expect(pathEntryExists("blocked/child")).rejects.toBe(failure);
  });

  it.each(["EACCES", "EIO", "not-found"])("preserves optional lstat failure %s", async (code) => {
    const failure = Object.assign(new Error("filesystem probe failed"), { code });
    vi.spyOn(fsPromises, "lstat").mockRejectedValue(failure);
    await expect(lstatIfExists("blocked")).rejects.toBe(failure);
  });

  it("requires executable regular targets while preserving Windows existence-only access", async () => {
    await withTestDir({ prefix: "openclaw-executable-" }, async (root) => {
      const file = path.join(root, "file");
      const directory = path.join(root, "directory");
      await fsPromises.writeFile(file, "fixture", { mode: 0o600 });
      await fsPromises.mkdir(directory);
      expect(await executableFileExists(file, "win32")).toBe(true);
      expect(executableFileExistsSync(file, "win32")).toBe(true);
      expect(await executableFileExists(directory, "win32")).toBe(false);
      expect(executableFileExistsSync(directory, "win32")).toBe(false);
      expect(await executableFileExists(path.join(root, "missing"), "win32")).toBe(false);
      expect(executableFileExistsSync(path.join(root, "missing"), "win32")).toBe(false);
      if (process.platform !== "win32") {
        expect(await executableFileExists(file, process.platform)).toBe(false);
        expect(executableFileExistsSync(file, process.platform)).toBe(false);
        await fsPromises.chmod(file, 0o700);
        const link = path.join(root, "link");
        await fsPromises.symlink(file, link, "file");
        expect(await executableFileExists(link, process.platform)).toBe(true);
        expect(executableFileExistsSync(link, process.platform)).toBe(true);
      }
    });
  });
});

it("distinguishes definite absence from paths that may still exist", () => {
  const root = tempDirs.make("openclaw-path-existence-");
  const present = path.join(root, "present");
  fs.writeFileSync(present, "");
  expect(pathMayExistSync(present)).toBe(true);
  expect(pathMayExistSync(path.join(root, "missing"))).toBe(false);

  const dangling = path.join(root, "dangling");
  fs.symlinkSync("missing-target", dangling);
  expect(pathMayExistSync(dangling)).toBe(true);
  const blockedByFile = path.join(present, "child");
  expect(() => fs.lstatSync(blockedByFile)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  expect(pathMayExistSync(blockedByFile)).toBe(false);
});

it.each(["EACCES", "EPERM", "ELOOP", "EIO"])("preserves uncertainty for %s", (code) => {
  const probe = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
    throw Object.assign(new Error("filesystem probe failed"), { code });
  });
  try {
    expect(pathMayExistSync("unreadable-path")).toBe(true);
  } finally {
    probe.mockRestore();
  }
});
