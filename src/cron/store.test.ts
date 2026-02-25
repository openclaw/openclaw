import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCronStore, resolveCronStorePath } from "./store.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activi-cron-store-"));
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

  it("uses ACTIVI_HOME for tilde expansion", () => {
    vi.stubEnv("ACTIVI_HOME", "/srv/activi-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/activi-home", "cron", "jobs.json"));
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
