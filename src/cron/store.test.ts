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
});

const isWindows = process.platform === "win32";
const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("saveCronStore file permissions", () => {
  it("creates the store file with 0o600 and directory with 0o700", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-perms-"));
    const cronDir = path.join(root, "cron");
    const storePath = path.join(cronDir, "jobs.json");

    try {
      await saveCronStore(storePath, { version: 1, jobs: [] });

      const dirStat = await fs.stat(cronDir);
      expectPerms(dirStat.mode & 0o777, 0o700);

      const fileStat = await fs.stat(storePath);
      expectPerms(fileStat.mode & 0o777, 0o600);

      const bakStat = await fs.stat(`${storePath}.bak`);
      expectPerms(bakStat.mode & 0o777, 0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
