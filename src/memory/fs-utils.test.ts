import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";

describe("fs-utils", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-fs-utils-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("detects ENOENT errors", () => {
    expect(isFileMissingError({ code: "ENOENT" })).toBe(true);
    expect(isFileMissingError({ code: "EACCES" })).toBe(false);
    expect(isFileMissingError(null)).toBe(false);
  });

  it("returns missing when file does not exist", async () => {
    const result = await statRegularFile(path.join(tmpDir, "missing.md"));
    expect(result).toEqual({ missing: true });
  });

  it("returns stat for regular files", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const result = await statRegularFile(filePath);
    expect(result.missing).toBe(false);
    if (!result.missing) {
      expect(result.stat.isFile()).toBe(true);
    }
  });

  it("throws when path is not a regular file", async () => {
    const dirPath = path.join(tmpDir, "notes");
    await fs.mkdir(dirPath, { recursive: true });

    await expect(statRegularFile(dirPath)).rejects.toThrow("path required");
  });

  it("rethrows non-ENOENT lstat errors", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);

    await expect(statRegularFile(path.join(tmpDir, "anything.md"))).rejects.toBe(denied);
  });
});
