import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkDirectoryOwnership } from "./update-global.js";

describe("checkDirectoryOwnership", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "update-global-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:true when all files are writable by the current process", async () => {
    const dir = path.join(tmpDir, "owned");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "hello");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "nested.txt"), "world");

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(true);
    expect(result.unwritableFiles).toHaveLength(0);
  });

  it("returns ok:false when a file is not writable", async () => {
    const dir = path.join(tmpDir, "unwritable-file");
    await fs.mkdir(dir, { recursive: true });
    const writableFile = path.join(dir, "mine.txt");
    const unwritableFile = path.join(dir, "locked.txt");
    await fs.writeFile(writableFile, "mine");
    await fs.writeFile(unwritableFile, "locked");

    const realAccess = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (p, mode?) => {
      if (String(p) === unwritableFile) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realAccess(p as string, mode);
    });

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(false);
    expect(result.unwritableFiles).toContain(unwritableFile);
  });

  it("returns ok:false when a directory is unreadable", async () => {
    const dir = path.join(tmpDir, "unreadable");
    await fs.mkdir(dir, { recursive: true });
    const subDir = path.join(dir, "restricted");
    await fs.mkdir(subDir, { recursive: true });

    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (p: unknown, opts?: unknown) => {
      if (String(p) === subDir) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realReaddir(p as string, opts as never);
    }) as never);

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(false);
    expect(result.unwritableFiles).toContain(subDir);
  });

  it("returns ok:false when the root directory itself is not writable", async () => {
    const dir = path.join(tmpDir, "unwritable-root");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "hello");

    const realAccess = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (p, mode?) => {
      if (String(p) === dir) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realAccess(p as string, mode);
    });

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(false);
    expect(result.unwritableFiles).toContain(dir);
  });

  it("returns ok:true for shared-install directories writable via group permissions", async () => {
    const dir = path.join(tmpDir, "group-writable");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "shared");

    // All fs.access calls succeed — simulates group/ACL-writable shared install
    vi.spyOn(fs, "access").mockResolvedValue(undefined);

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(true);
    expect(result.unwritableFiles).toHaveLength(0);
  });
});
