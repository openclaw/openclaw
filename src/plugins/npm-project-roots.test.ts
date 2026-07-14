// Covers managed npm project root resolution with error handling.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listManagedPluginNpmProjectRootsSync,
  listManagedPluginNpmRoots,
} from "./npm-project-roots.js";

function makeDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as fs.Dirent;
}

describe("listManagedPluginNpmProjectRootsSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns sorted directory entries from projects dir", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValueOnce([
      makeDirent("z-package", true),
      makeDirent("a-package", true),
      makeDirent("m-package", true),
    ] as fs.Dirent[]);

    const result = listManagedPluginNpmProjectRootsSync("/fake/npm");
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("a-package");
    expect(result[1]).toContain("m-package");
    expect(result[2]).toContain("z-package");
  });

  it("filters out non-directory entries", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValueOnce([
      makeDirent("file.txt", false),
      makeDirent("valid-plugin", true),
    ] as fs.Dirent[]);

    const result = listManagedPluginNpmProjectRootsSync("/fake/npm");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("valid-plugin");
  });

  it("returns empty array on ENOENT", () => {
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    const result = listManagedPluginNpmProjectRootsSync("/fake/npm");
    expect(result).toEqual([]);
  });

  it("returns empty array on ENOTDIR (path is a file, not a directory)", () => {
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    });

    const result = listManagedPluginNpmProjectRootsSync("/fake/npm");
    expect(result).toEqual([]);
  });

  it("rethrows on other errors like EACCES", () => {
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(() => listManagedPluginNpmProjectRootsSync("/fake/npm")).toThrow();
  });

  it("rethrows on unknown errors", () => {
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("unknown error"), { code: "UNKNOWN" });
    });

    expect(() => listManagedPluginNpmProjectRootsSync("/fake/npm")).toThrow();
  });
});

describe("listManagedPluginNpmRoots (async, wraps listManagedPluginNpmProjectRoots)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns npmRoot + sorted directory entries", async () => {
    vi.spyOn(fsp, "readdir").mockResolvedValueOnce([
      makeDirent("z-package", true),
      makeDirent("a-package", true),
    ] as unknown as fs.Dirent[]);

    const result = await listManagedPluginNpmRoots("/fake/npm");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("/fake/npm"); // npmRoot is prepended
    expect(result[1]).toContain("a-package");
    expect(result[2]).toContain("z-package");
  });

  it("filters out non-directory entries", async () => {
    vi.spyOn(fsp, "readdir").mockResolvedValueOnce([
      makeDirent("file.txt", false),
      makeDirent("valid-plugin", true),
    ] as unknown as fs.Dirent[]);

    const result = await listManagedPluginNpmRoots("/fake/npm");
    expect(result).toHaveLength(2); // npmRoot + valid-plugin
    expect(result[1]).toContain("valid-plugin");
  });

  it("returns [npmRoot] on ENOENT (projects dir missing)", async () => {
    vi.spyOn(fsp, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: "ENOENT" }),
    );

    const result = await listManagedPluginNpmRoots("/fake/npm");
    expect(result).toEqual(["/fake/npm"]);
  });

  it("returns [npmRoot] on ENOTDIR (projects path is a file)", async () => {
    vi.spyOn(fsp, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("not a directory"), { code: "ENOTDIR" }),
    );

    const result = await listManagedPluginNpmRoots("/fake/npm");
    expect(result).toEqual(["/fake/npm"]);
  });

  it("rethrows on other errors like EACCES", async () => {
    vi.spyOn(fsp, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(listManagedPluginNpmRoots("/fake/npm")).rejects.toThrow();
  });

  it("rethrows on unknown errors", async () => {
    vi.spyOn(fsp, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("unknown error"), { code: "UNKNOWN" }),
    );

    await expect(listManagedPluginNpmRoots("/fake/npm")).rejects.toThrow();
  });
});
