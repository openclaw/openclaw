import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageBackend } from "./factory.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-factory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

describe("backup/storage/factory", () => {
  it("returns local storage by default (no config)", async () => {
    const storage = await createStorageBackend();

    // Should be a working local storage — verify by checking it has the expected methods
    expect(typeof storage.put).toBe("function");
    expect(typeof storage.get).toBe("function");
    expect(typeof storage.list).toBe("function");
    expect(typeof storage.delete).toBe("function");
    expect(typeof storage.exists).toBe("function");
  });

  it("returns local storage with explicit type", async () => {
    const dir = await makeTempDir();
    const storage = await createStorageBackend({ type: "local", path: dir });

    await storage.put("test.tar.gz", Buffer.from("data"));
    expect(await storage.exists("test.tar.gz")).toBe(true);
    const retrieved = await storage.get("test.tar.gz");
    expect(retrieved.toString()).toBe("data");
  });

  it("returns local storage with custom path", async () => {
    const dir = await makeTempDir();
    const customPath = path.join(dir, "custom-backups");
    const storage = await createStorageBackend({
      type: "local",
      path: customPath,
    });

    await storage.put("backup.tar.gz", Buffer.from("content"));
    const onDisk = await fs.readFile(path.join(customPath, "backup.tar.gz"));
    expect(onDisk.toString()).toBe("content");
  });

  it("throws for S3 without config", async () => {
    await expect(createStorageBackend({ type: "s3" })).rejects.toThrow();
  });
});
