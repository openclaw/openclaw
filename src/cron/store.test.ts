import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  importLegacyCronStateFileToSqlite,
  importLegacyCronStoreToSqlite,
  loadLegacyCronStoreForMigration,
} from "../commands/doctor/legacy/cron-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  loadCronStore,
  loadCronStoreSync,
  resolveLegacyCronStorePath,
  saveCronStore,
  updateCronStoreJobs,
} from "./store.js";
import type { CronStoreFile } from "./types.js";

let fixtureRoot = "";
let caseId = 0;
let originalOpenClawStateDir: string | undefined;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
});

afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function makeStorePath() {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
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

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("resolveLegacyCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveLegacyCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  it("returns empty store when SQLite has no rows for the store key", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
  });

  it("ignores invalid legacy jobs.json at runtime but rejects it during migration", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{ not json", "utf-8");

    await expect(loadCronStore(store.storePath)).resolves.toEqual({ version: 1, jobs: [] });
    await expect(loadLegacyCronStoreForMigration(store.storePath)).rejects.toThrow(
      /Failed to parse cron store/i,
    );
  });

  it("accepts JSON5 syntax when doctor loads a legacy cron store", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      `{
        // hand-edited legacy store
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'Job 1',
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: 'every', everyMs: 60000 },
            sessionTarget: 'main',
            wakeMode: 'next-heartbeat',
            payload: { kind: 'systemEvent', text: 'tick-job-1' },
            state: {},
          },
        ],
      }`,
      "utf-8",
    );

    await expect(loadLegacyCronStoreForMigration(store.storePath)).resolves.toMatchObject({
      version: 1,
      jobs: [{ id: "job-1", enabled: true }],
    });
  });

  it("persists and round-trips job definitions through SQLite without writing jobs.json", async () => {
    const { storePath } = await makeStorePath();
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = {
      nextRunAtMs: payload.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storePath, payload);

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]).toMatchObject({
      id: "job-1",
      state: { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 },
    });
    await expectPathMissing(storePath);
    await expectPathMissing(`${storePath}.bak`);
  });

  it("loads SQLite state synchronously for task reconciliation", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, makeStore("job-sync", true));

    const loaded = loadCronStoreSync(storePath);

    expect(loaded.jobs[0]).toMatchObject({
      id: "job-sync",
      state: expect.any(Object),
      updatedAtMs: expect.any(Number),
    });
  });

  it("stateOnly saves runtime state without replacing job definitions", async () => {
    const { storePath } = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);
    second.jobs[0].state = {
      nextRunAtMs: second.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storePath, first);
    await saveCronStore(storePath, second, { stateOnly: true });

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1"]);
    expect(loaded.jobs[0]?.state).toEqual({});
  });

  it("updates matching cron rows without rewriting the whole store", async () => {
    const { storePath } = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", true);
    second.jobs[0].delivery = { channel: "telegram", to: "@old" } as never;
    first.jobs.push(second.jobs[0]);
    await saveCronStore(storePath, first);

    const result = await updateCronStoreJobs(storePath, (job) => {
      if (job.id !== "job-2") {
        return undefined;
      }
      return {
        ...job,
        delivery: { channel: "telegram", to: "-100123" } as never,
      };
    });

    const loaded = await loadCronStore(storePath);
    expect(result).toEqual({ updatedJobs: 1 });
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(loaded.jobs[0]).toMatchObject({ id: "job-1" });
    expect("delivery" in (loaded.jobs[0] ?? {})).toBe(false);
    expect(loaded.jobs[1]).toMatchObject({
      id: "job-2",
      delivery: { channel: "telegram", to: "-100123" },
    });
    await expectPathMissing(storePath);
  });

  it("imports legacy jobs.json into SQLite and removes the source file", async () => {
    const store = await makeStorePath();
    const legacy = makeStore("legacy-job", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(legacy, null, 2), "utf-8");

    await expect(
      importLegacyCronStoreToSqlite({
        legacyStorePath: store.storePath,
        storeKey: store.storePath,
      }),
    ).resolves.toMatchObject({
      imported: true,
      importedJobs: 1,
      removedPath: store.storePath,
    });

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.jobs[0]?.id).toBe("legacy-job");
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
    await expectPathMissing(store.storePath);
  });

  it("imports legacy state sidecars into SQLite and sanitizes invalid updatedAtMs values", async () => {
    const store = await makeStorePath();
    const job = makeStore("job-1", true).jobs[0];
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        { ...job, state: {}, updatedAtMs: undefined } as unknown as CronStoreFile["jobs"][number],
      ],
    });
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            [job.id]: {
              updatedAtMs: "invalid",
              state: { nextRunAtMs: job.createdAtMs + 60_000 },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await importLegacyCronStateFileToSqlite({
      legacyStorePath: store.storePath,
      storeKey: store.storePath,
    });
    const loaded = await loadCronStore(store.storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(job.createdAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
    await expectPathMissing(statePath);
  });

  it("propagates unreadable legacy state sidecar errors during doctor import", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(store.storePath, payload);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 1, jobs: { "job-1": { state: {} } } }),
      "utf-8",
    );

    const origReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === statePath) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origReadFile(filePath, options as never) as never;
    });

    try {
      await expect(
        importLegacyCronStateFileToSqlite({
          legacyStorePath: store.storePath,
          storeKey: store.storePath,
        }),
      ).rejects.toThrow(/Failed to read cron state/);
    } finally {
      spy.mockRestore();
    }
  });
});
