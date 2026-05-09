import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import type { CronStoreFile } from "../../../cron/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  importLegacyCronStateFileToSqlite,
  importLegacyCronStoreToSqlite,
  loadLegacyCronStoreForMigration,
  resolveLegacyCronStorePath,
} from "./cron-store.js";

let tempRoot = "";
let originalOpenClawStateDir: string | undefined;

async function makeStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-legacy-cron-store-"));
  originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(tempRoot, "state");
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  return storePath;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  originalOpenClawStateDir = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

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
  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveLegacyCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("legacy cron store migration", () => {
  it("rejects invalid legacy jobs.json during migration", async () => {
    const storePath = await makeStorePath();
    await fs.writeFile(storePath, "{ not json", "utf-8");

    await expect(loadLegacyCronStoreForMigration(storePath)).rejects.toThrow(
      /Failed to parse cron store/i,
    );
  });

  it("accepts JSON5 syntax when doctor loads a legacy cron store", async () => {
    const storePath = await makeStorePath();
    await fs.writeFile(
      storePath,
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

    await expect(loadLegacyCronStoreForMigration(storePath)).resolves.toMatchObject({
      version: 1,
      jobs: [{ id: "job-1", enabled: true }],
    });
  });

  it("imports legacy jobs.json into SQLite and removes the source file", async () => {
    const storePath = await makeStorePath();
    const legacy = makeStore("legacy-job", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };

    await fs.writeFile(storePath, JSON.stringify(legacy, null, 2), "utf-8");

    await expect(
      importLegacyCronStoreToSqlite({
        legacyStorePath: storePath,
        storeKey: storePath,
      }),
    ).resolves.toMatchObject({
      imported: true,
      importedJobs: 1,
      removedPath: storePath,
    });

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.id).toBe("legacy-job");
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
    await expectPathMissing(storePath);
  });

  it("imports legacy state sidecars into SQLite and sanitizes invalid updatedAtMs values", async () => {
    const storePath = await makeStorePath();
    const job = makeStore("job-1", true).jobs[0];
    const statePath = storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        { ...job, state: {}, updatedAtMs: undefined } as unknown as CronStoreFile["jobs"][number],
      ],
    });
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
      legacyStorePath: storePath,
      storeKey: storePath,
    });
    const loaded = await loadCronStore(storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(job.createdAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
    await expectPathMissing(statePath);
  });

  it("propagates unreadable legacy state sidecar errors during doctor import", async () => {
    const storePath = await makeStorePath();
    const payload = makeStore("job-1", true);
    const statePath = storePath.replace(/\.json$/, "-state.json");

    await saveCronStore(storePath, payload);
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 1, jobs: { "job-1": { state: {} } } }),
      "utf-8",
    );

    const origReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === statePath) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origReadFile(filePath, options as never) as never;
    });

    await expect(
      importLegacyCronStateFileToSqlite({
        legacyStorePath: storePath,
        storeKey: storePath,
      }),
    ).rejects.toThrow(/Failed to read cron state/);
  });
});
