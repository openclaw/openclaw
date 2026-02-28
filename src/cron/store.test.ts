import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("fails fast when loading a store with missing job ids", async () => {
    const store = await makeStorePath();
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [{ name: "missing-id" }],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/missing a non-empty id .*load/i);
    await store.cleanup();
  });

  it("fails fast when loading a store with duplicate job ids", async () => {
    const store = await makeStorePath();
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [{ id: "dup" }, { id: "dup" }],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/duplicate job id "dup" .*load/i);
    await store.cleanup();
  });

  it("fails fast when saving a store with duplicate job ids", async () => {
    const store = await makeStorePath();
    await expect(
      saveCronStore(store.storePath, {
        version: 1,
        jobs: [{ id: "dup" } as never, { id: "dup" } as never],
      }),
    ).rejects.toThrow(/duplicate job id "dup" .*save/i);
    await store.cleanup();
  });
});
