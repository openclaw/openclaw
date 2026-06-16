import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { migrateCronScheduleActivationTimestamps } from "./schedule-activation-migration.js";

let tempRoot: string | null = null;

async function makeStorePath(): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-activation-migration-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

function makeJob(params: {
  id: string;
  scheduleKind?: "cron" | "every";
  updatedAtMs: number;
  scheduleActivatedAtMs?: number;
}): CronJob {
  const schedule =
    params.scheduleKind === "every"
      ? ({ kind: "every", everyMs: 60_000, anchorMs: params.updatedAtMs } as const)
      : ({ kind: "cron", expr: "0 8 * * *", tz: "UTC" } as const);
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.updatedAtMs - 86_400_000,
    updatedAtMs: params.updatedAtMs,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: params.id },
    state: {
      nextRunAtMs: params.updatedAtMs + 86_400_000,
      ...(params.scheduleActivatedAtMs !== undefined
        ? { scheduleActivatedAtMs: params.scheduleActivatedAtMs }
        : {}),
    },
  };
}

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("migrateCronScheduleActivationTimestamps", () => {
  it("reactivates legacy cron schedules at migration time", async () => {
    const storePath = await makeStorePath();
    const definitionUpdatedAtMs = Date.parse("2026-06-10T14:30:00.000Z");
    const metadataUpdatedAtMs = Date.parse("2026-06-10T16:00:00.000Z");
    const runtimeUpdatedAtMs = Date.parse("2026-06-11T08:05:00.000Z");
    const migratedAtMs = Date.parse("2026-06-12T09:00:00.000Z");
    const job = makeJob({ id: "monthly-report", updatedAtMs: definitionUpdatedAtMs });
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    job.name = "renamed monthly report";
    job.updatedAtMs = metadataUpdatedAtMs;
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    job.updatedAtMs = runtimeUpdatedAtMs;
    job.state.lastRunAtMs = runtimeUpdatedAtMs;
    await saveCronStore(storePath, { version: 1, jobs: [job] }, { stateOnly: true });

    expect(migrateCronScheduleActivationTimestamps(storePath, migratedAtMs)).toBe(1);

    const migrated = (await loadCronStore(storePath)).jobs[0];
    expect(migrated?.updatedAtMs).toBe(runtimeUpdatedAtMs);
    expect(migrated?.state.scheduleActivatedAtMs).toBe(migratedAtMs);
  });

  it("preserves canonical timestamps and ignores non-cron schedules", async () => {
    const storePath = await makeStorePath();
    const updatedAtMs = Date.parse("2026-06-10T14:30:00.000Z");
    const canonicalAtMs = updatedAtMs - 60_000;
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        makeJob({
          id: "canonical-cron",
          updatedAtMs,
          scheduleActivatedAtMs: canonicalAtMs,
        }),
        makeJob({ id: "every-job", scheduleKind: "every", updatedAtMs }),
      ],
    });

    expect(migrateCronScheduleActivationTimestamps(storePath)).toBe(0);

    const jobs = (await loadCronStore(storePath)).jobs;
    expect(jobs[0]?.state.scheduleActivatedAtMs).toBe(canonicalAtMs);
    expect(jobs[1]?.state.scheduleActivatedAtMs).toBeUndefined();
  });
});
