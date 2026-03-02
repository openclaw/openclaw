import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "./store.js";
import type { CronStoreFile } from "./types.js";

let fixtureRoot = "";
let fixtureCount = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
});

afterAll(async () => {
  if (!fixtureRoot) {
    return;
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

async function makeStorePath() {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
  };
}

function makeStore(jobId: string, enabled: boolean): CronStoreFile {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: `Job ${jobId}`,
        enabled,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `tick-${jobId}` },
        state: {},
      },
    ],
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
  });

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
  });

  it("does not create a backup file when saving unchanged content", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);

    await saveCronStore(store.storePath, payload);
    await saveCronStore(store.storePath, payload);

    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toThrow();
  });

  it("backs up previous content before replacing the store", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);

    await saveCronStore(store.storePath, first);
    await saveCronStore(store.storePath, second);

    const currentRaw = await fs.readFile(store.storePath, "utf-8");
    const backupRaw = await fs.readFile(`${store.storePath}.bak`, "utf-8");
    expect(JSON.parse(currentRaw)).toEqual(second);
    expect(JSON.parse(backupRaw)).toEqual(first);
  });
});

describe("saveCronStore", () => {
  const dummyStore: CronStoreFile = { version: 1, jobs: [] };

  it("persists and round-trips a store file", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);
  });

  it("retries rename on EBUSY then succeeds", async () => {
    const { storePath } = await makeStorePath();
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
        realSetTimeout(handler, 0, ...args)) as typeof setTimeout);
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

    try {
      await saveCronStore(storePath, dummyStore);

      expect(ebusyCount).toBe(2);
      const loaded = await loadCronStore(storePath);
      expect(loaded).toEqual(dummyStore);
    } finally {
      spy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("falls back to copyFile on EPERM (Windows)", async () => {
    const { storePath } = await makeStorePath();

    const spy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    await saveCronStore(storePath, dummyStore);
    const loaded = await loadCronStore(storePath);
    expect(loaded).toEqual(dummyStore);

    spy.mockRestore();
  });
});
