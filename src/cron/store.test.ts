import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronStoreFile } from "./types.js";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "./store.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
    await store.cleanup();
  });

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
    await store.cleanup();
  });
});

describe("saveCronStore", () => {
  const dummyStore: CronStoreFile = { version: 1, jobs: [] };

  it("persists and round-trips a store file", async () => {
    const { storePath, cleanup } = await makeStorePath();
    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);
    await cleanup();
  });

  it("retries rename on EBUSY then succeeds", async () => {
    const { storePath, cleanup } = await makeStorePath();

    const origRename = fs.rename.bind(fs);
    let ebusyCount = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      if (ebusyCount < 2) {
        ebusyCount++;
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return origRename(src, dest);
    });

    await saveCronStore(storePath, dummyStore);
    expect(ebusyCount).toBe(2);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);

    spy.mockRestore();
    await cleanup();
  });

  it("falls back to copyFile on EPERM (Windows)", async () => {
    const { storePath, cleanup } = await makeStorePath();

    const spy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);

    spy.mockRestore();
    await cleanup();
  });
});
