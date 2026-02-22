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

  it("returns ok:true when all files are owned by the current user", async () => {
    const dir = path.join(tmpDir, "owned");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "hello");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "nested.txt"), "world");

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(true);
    expect(result.foreignFiles).toHaveLength(0);
  });

  it("returns ok:false when a foreign-owned file is present", async () => {
    if (typeof process.getuid !== "function") {
      // Skip on platforms without getuid
      return;
    }

    const dir = path.join(tmpDir, "foreign");
    await fs.mkdir(dir, { recursive: true });
    const ownedFile = path.join(dir, "mine.txt");
    const foreignFile = path.join(dir, "foreign.txt");
    await fs.writeFile(ownedFile, "mine");
    await fs.writeFile(foreignFile, "foreign");

    const currentUid = process.getuid();
    const foreignUid = currentUid === 0 ? 1 : 0;

    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (p, opts?) => {
      const stat = await realLstat(p as string, opts as never);
      if (String(p) === foreignFile) {
        const fakeStat = Object.create(Object.getPrototypeOf(stat) as object) as typeof stat;
        Object.assign(fakeStat, stat);
        Object.defineProperty(fakeStat, "uid", {
          value: foreignUid,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return fakeStat;
      }
      return stat;
    });

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(false);
    expect(result.foreignFiles).toContain(foreignFile);
  });

  it("returns ok:false when a directory is unreadable", async () => {
    if (typeof process.getuid !== "function") {
      return;
    }

    const dir = path.join(tmpDir, "unreadable");
    await fs.mkdir(dir, { recursive: true });
    const subDir = path.join(dir, "restricted");
    await fs.mkdir(subDir, { recursive: true });

    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (p, opts?) => {
      if (String(p) === subDir) {
        throw new Error("EACCES: permission denied");
      }
      return realReaddir(p as string, opts as never);
    });

    const result = await checkDirectoryOwnership(dir);

    expect(result.ok).toBe(false);
    expect(result.foreignFiles).toContain(subDir);
  });

  it("returns ok:true when process.getuid is unavailable (Windows)", async () => {
    const originalGetuid = process.getuid;
    try {
      // Simulate Windows / environments without getuid
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).getuid = undefined;

      const result = await checkDirectoryOwnership(tmpDir);

      expect(result.ok).toBe(true);
      expect(result.foreignFiles).toHaveLength(0);
    } finally {
      process.getuid = originalGetuid;
    }
  });
});
