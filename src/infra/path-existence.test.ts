import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as paths from "./path-existence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = tempDirs.make("path-discovery-");
  const at = (name: string) => path.join(root, name);
  const file = at("file"),
    directory = at("directory"),
    link = at("link");
  const missing = at("missing"),
    dangling = at("dangling"),
    child = path.join(file, "child");
  fs.writeFileSync(file, "fixture", { mode: 0o600 });
  fs.mkdirSync(directory);
  fs.symlinkSync(file, link, "file");
  fs.symlinkSync(missing, dangling, "file");
  return { root, file, directory, link, dangling, missing, child };
}

it("distinguishes entries from followed targets and returns typed directory entries", async () => {
  const { root, file, link, dangling, missing, child } = fixture();
  expect(await paths.realpathOrResolve(link)).toBe(fs.realpathSync.native(file));
  expect(await paths.realpathOrResolve(dangling)).toBe(dangling);
  expect(await paths.realpathOrResolve(path.relative(process.cwd(), missing))).toBe(missing);
  expect(await paths.pathEntryExists(dangling)).toBe(true);
  expect(await paths.pathEntryExists(missing)).toBe(false);
  expect((await paths.lstatIfExists(dangling))?.isSymbolicLink()).toBe(true);
  expect(await paths.lstatIfExists(missing)).toBeUndefined();
  expect(await paths.lstatIfExists(child)).toBeUndefined();
  await expect(paths.lstatIfExists(child, "ENOENT")).rejects.toMatchObject({ code: "ENOTDIR" });
  for (const [stat, absent] of [
    [paths.statIfExists, undefined],
    [paths.safeStat, null],
  ] as const) {
    expect((await stat(link))?.isFile()).toBe(true);
    expect(await stat(dangling)).toBe(absent);
  }
  await expect(paths.statIfExists(child)).rejects.toMatchObject({ code: "ENOTDIR" });
  const entries = paths.readDirectoryEntriesSync(root);
  expect(entries.find((entry) => entry.name === "directory")?.isDirectory()).toBe(true);
  expect(paths.readDirectoryEntriesSync(missing)).toEqual([]);
  expect(paths.readDirectoryEntriesSync(file)).toEqual([]);
});

it("uses the lexical absolute path when realpath fails beyond definite absence", async () => {
  vi.spyOn(fsPromises, "realpath").mockRejectedValue(
    Object.assign(new Error("filesystem probe failed"), { code: "EACCES" }),
  );
  expect(await paths.realpathOrResolve("blocked/../missing")).toBe(path.resolve("missing"));
});

it.each([
  ["async", paths.canAccess, paths.executableFileExists],
  ["sync", paths.canAccessSync, paths.executableFileExistsSync],
] as const)(
  "%s discovery preserves access modes and requires regular executables",
  async (_kind, access, executable) => {
    const { file, directory, missing, link } = fixture();
    expect(await access(file, fs.constants.R_OK)).toBe(true);
    expect(await access(missing)).toBe(false);
    expect(await executable(file, "win32")).toBe(true);
    expect(await executable(directory, "win32")).toBe(false);
    expect(await executable(missing, "win32")).toBe(false);
    if (process.platform !== "win32") {
      expect(await access(file, fs.constants.X_OK)).toBe(false);
      expect(await executable(file, process.platform)).toBe(false);
      await fsPromises.chmod(file, 0o700);
      expect(await access(file, fs.constants.X_OK)).toBe(true);
      expect(await executable(link, process.platform)).toBe(true);
    }
  },
);

it.each([
  ["lstat", paths.pathEntryExists, "ENOTDIR"],
  ["lstat", paths.lstatIfExists, "EACCES"],
  ["lstat", paths.lstatIfExists, "not-found"],
  ["stat", paths.statIfExists, "EACCES"],
] as const)("propagates %s probe failure through %s: %s", async (method, probe, code) => {
  const failure = Object.assign(new Error("filesystem probe failed"), { code });
  vi.spyOn(fsPromises, method).mockRejectedValue(failure);
  await expect(probe("blocked/child")).rejects.toBe(failure);
});

it("distinguishes definite absence from paths that may still exist", () => {
  const { missing, dangling, child } = fixture();
  expect(paths.pathMayExistSync(missing)).toBe(false);
  expect(paths.pathMayExistSync(dangling)).toBe(true);
  expect(() => fs.lstatSync(child)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  expect(paths.pathMayExistSync(child)).toBe(false);
});

it("preserves uncertainty for inaccessible paths", () => {
  vi.spyOn(fs, "lstatSync").mockImplementation(() => {
    throw Object.assign(new Error("filesystem probe failed"), { code: "EACCES" });
  });
  expect(paths.pathMayExistSync("unreadable-path")).toBe(true);
});
