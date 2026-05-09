import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadCronStore, loadCronStoreSync, saveCronStore, updateCronStoreJobs } from "./store.js";
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

function makeStoreKey() {
  return {
    storeKey: `case-${caseId++}`,
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

describe("cron store", () => {
  it("returns empty store when SQLite has no rows for the store key", async () => {
    const { storeKey } = makeStoreKey();
    const loaded = await loadCronStore(storeKey);
    expect(loaded).toEqual({ version: 1, jobs: [] });
  });

  it("persists and round-trips job definitions through SQLite without writing jobs.json", async () => {
    const { storeKey } = makeStoreKey();
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = {
      nextRunAtMs: payload.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storeKey, payload);

    const loaded = await loadCronStore(storeKey);
    expect(loaded.jobs[0]).toMatchObject({
      id: "job-1",
      state: { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 },
    });
  });

  it("loads SQLite state synchronously for task reconciliation", async () => {
    const { storeKey } = makeStoreKey();
    await saveCronStore(storeKey, makeStore("job-sync", true));

    const loaded = loadCronStoreSync(storeKey);

    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-sync");
    expect(loaded.jobs[0]?.state).toStrictEqual({});
    expect(loaded.jobs[0]?.updatedAtMs).toBeTypeOf("number");
  });

  it("stateOnly saves runtime state without replacing job definitions", async () => {
    const { storeKey } = makeStoreKey();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);
    second.jobs[0].state = {
      nextRunAtMs: second.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storeKey, first);
    await saveCronStore(storeKey, second, { stateOnly: true });

    const loaded = await loadCronStore(storeKey);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1"]);
    expect(loaded.jobs[0]?.state).toEqual({});
  });

  it("updates matching cron rows without rewriting the whole store", async () => {
    const { storeKey } = makeStoreKey();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", true);
    second.jobs[0].delivery = { channel: "telegram", to: "@old" } as never;
    first.jobs.push(second.jobs[0]);
    await saveCronStore(storeKey, first);

    const result = await updateCronStoreJobs(storeKey, (job) => {
      if (job.id !== "job-2") {
        return undefined;
      }
      return {
        ...job,
        delivery: { channel: "telegram", to: "-100123" } as never,
      };
    });

    const loaded = await loadCronStore(storeKey);
    expect(result).toEqual({ updatedJobs: 1 });
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(loaded.jobs[0]).toMatchObject({ id: "job-1" });
    expect("delivery" in (loaded.jobs[0] ?? {})).toBe(false);
    expect(loaded.jobs[1]).toMatchObject({
      id: "job-2",
      delivery: { channel: "telegram", to: "-100123" },
    });
  });
});
