import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCronStore } from "./store.js";

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
