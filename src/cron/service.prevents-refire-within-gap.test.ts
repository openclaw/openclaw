import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer, stopTimer } from "./service/timer.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    dir,
  };
}

describe("CronService - prevents duplicate fire within refire gap (#16094)", () => {
  const cleanups: Array<{ state: ReturnType<typeof createCronServiceState>; dir: string }> = [];

  afterEach(async () => {
    for (const { state, dir } of cleanups) {
      stopTimer(state);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanups.length = 0;
    vi.clearAllMocks();
  });

  it("skips a job whose lastRunAtMs is within MIN_REFIRE_GAP_MS", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-14T16:02:30.000Z");

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    cleanups.push({ state, dir: store.dir });

    // Simulate a job that just ran 10 seconds ago but whose nextRunAtMs
    // hasn't been recomputed yet (still points to the old schedule).
    // This is the race condition from #16094.
    const job: CronJob = {
      id: "exercise-reminder",
      name: "exercise-reminder",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      schedule: { kind: "cron", expr: "0 16 * * *", tz: "Asia/Shanghai" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Exercise time!" },
      delivery: { mode: "announce" },
      state: {
        // Job ran 10 seconds ago (within the 30s gap)
        lastRunAtMs: now - 10_000,
        lastStatus: "ok",
        lastDurationMs: 155_000,
        // nextRunAtMs still points to the old scheduled time (not yet recomputed)
        nextRunAtMs: Date.parse("2026-02-14T08:00:00.000Z"),
      },
    };

    state.store = { version: 1, jobs: [job] };

    // Persist the store so ensureLoaded can read it
    const storeDir = path.dirname(store.storePath);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(state.store));

    await onTimer(state);

    // The job should NOT have been executed because it ran too recently
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("allows a job to run when lastRunAtMs is older than MIN_REFIRE_GAP_MS", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-14T16:00:01.000Z");

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    cleanups.push({ state, dir: store.dir });

    // Job last ran >24h ago — should be allowed to fire
    const job: CronJob = {
      id: "exercise-reminder-2",
      name: "exercise-reminder-2",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      schedule: { kind: "cron", expr: "0 16 * * *", tz: "Asia/Shanghai" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Exercise time!" },
      delivery: { mode: "announce" },
      state: {
        lastRunAtMs: now - 86400_000,
        lastStatus: "ok",
        nextRunAtMs: now - 1_000, // 1 second ago — due
      },
    };

    state.store = { version: 1, jobs: [job] };

    const storeDir = path.dirname(store.storePath);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(state.store));

    await onTimer(state);

    // The job SHOULD have been executed — last run was >24h ago
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not block short-interval 'every' schedules", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-14T16:00:10.000Z");

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    cleanups.push({ state, dir: store.dir });

    // An "every 10s" job that ran 10s ago — should be allowed to fire
    // because the refire gap for every:10s is 5s (half the interval).
    const job: CronJob = {
      id: "frequent-check",
      name: "frequent-check",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      schedule: { kind: "every", everyMs: 10_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Quick check" },
      delivery: { mode: "none" },
      state: {
        lastRunAtMs: now - 10_000, // 10s ago, gap is 5s → should pass
        lastStatus: "ok",
        nextRunAtMs: now - 1, // due
      },
    };

    state.store = { version: 1, jobs: [job] };

    const storeDir = path.dirname(store.storePath);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(state.store));

    await onTimer(state);

    // The job SHOULD have been executed — 10s > 5s gap
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });
});
