import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStorage } from "./local.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

describe("backup/storage/local", () => {
  it("put + get roundtrip", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);
    const data = Buffer.from("test backup content");

    await storage.put("backup-2026.tar.gz", data);
    const retrieved = await storage.get("backup-2026.tar.gz");
    expect(Buffer.compare(retrieved, data)).toBe(0);
  });

  it("creates directory on first put", async () => {
    const dir = path.join(await makeTempDir(), "nested", "backups");
    const storage = createLocalStorage(dir);

    await storage.put("test.tar.gz", Buffer.from("data"));
    const exists = await fs
      .access(path.join(dir, "test.tar.gz"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("exists returns true for stored files", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await storage.put("backup.tar.gz", Buffer.from("data"));
    expect(await storage.exists("backup.tar.gz")).toBe(true);
  });

  it("exists returns false for missing files", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    expect(await storage.exists("nonexistent.tar.gz")).toBe(false);
  });

  it("delete removes file and sidecar", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await storage.put("backup.tar.gz", Buffer.from("archive"));
    await storage.put("backup.tar.gz.manifest.json", Buffer.from("{}"));

    await storage.delete("backup.tar.gz");
    expect(await storage.exists("backup.tar.gz")).toBe(false);
    expect(await storage.exists("backup.tar.gz.manifest.json")).toBe(false);
  });

  it("delete is idempotent for missing files", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    // Should not throw
    await storage.delete("nonexistent.tar.gz");
  });

  it("list returns empty for empty directory", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    const entries = await storage.list();
    expect(entries).toEqual([]);
  });

  it("list returns empty for nonexistent directory", async () => {
    const dir = path.join(os.tmpdir(), `openclaw-nonexistent-${Date.now()}`);
    const storage = createLocalStorage(dir);

    const entries = await storage.list();
    expect(entries).toEqual([]);
  });

  it("list returns .tar.gz files sorted newest first", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await storage.put("backup-a.tar.gz", Buffer.from("a"));
    // Small delay to ensure different mtimes
    await new Promise((r) => setTimeout(r, 50));
    await storage.put("backup-b.tar.gz", Buffer.from("b"));

    const entries = await storage.list();
    expect(entries).toHaveLength(2);
    // Sorted alphabetically then reversed → b first
    expect(entries[0].id).toBe("backup-b.tar.gz");
    expect(entries[1].id).toBe("backup-a.tar.gz");
  });

  it("list skips non-.tar.gz files", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await storage.put("backup.tar.gz", Buffer.from("archive"));
    await storage.put("backup.tar.gz.manifest.json", Buffer.from("{}"));
    await storage.put("readme.txt", Buffer.from("notes"));

    const entries = await storage.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("backup.tar.gz");
  });

  it("list enriches from sidecar manifest", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await storage.put("backup.tar.gz", Buffer.from("archive"));
    await storage.put(
      "backup.tar.gz.manifest.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          createdAt: "2026-02-01T00:00:00.000Z",
          openclawVersion: "2026.1.1",
          components: ["config", "workspace"],
          entries: [],
          label: "daily",
          encrypted: true,
        }),
      ),
    );

    const entries = await storage.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(entries[0].components).toEqual(["config", "workspace"]);
    expect(entries[0].label).toBe("daily");
    expect(entries[0].encrypted).toBe(true);
  });

  it("get throws for missing files", async () => {
    const dir = await makeTempDir();
    const storage = createLocalStorage(dir);

    await expect(storage.get("nonexistent.tar.gz")).rejects.toThrow();
  });
});
