import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-maxruns-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForJobs(cron: CronService, predicate: (jobs: CronJob[]) => boolean) {
  let latest: CronJob[] = [];
  for (let i = 0; i < 30; i++) {
    latest = await cron.list({ includeDisabled: true });
    if (predicate(latest)) {
      return latest;
    }
    await vi.runOnlyPendingTimersAsync();
  }
  return latest;
}

describe("CronService maxRuns", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes a recurring job after maxRuns executions", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-delete",
      enabled: true,
      deleteAfterRun: true,
      maxRuns: 3,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check subagent" },
    });

    expect(job.maxRuns).toBe(3);
    expect(job.deleteAfterRun).toBe(true);

    // Run 1
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    let jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && item.state.totalRuns === 1),
    );
    expect(jobs.find((j) => j.id === job.id)).toBeDefined();

    // Run 2
    vi.setSystemTime(new Date("2025-12-13T00:02:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && item.state.totalRuns === 2),
    );
    expect(jobs.find((j) => j.id === job.id)).toBeDefined();

    // Run 3 — should be deleted
    vi.setSystemTime(new Date("2025-12-13T00:03:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    jobs = await waitForJobs(cron, (items) => !items.some((item) => item.id === job.id));
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(3);

    cron.stop();
    await store.cleanup();
  });

  it("disables instead of deleting when deleteAfterRun is false", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-disable",
      enabled: true,
      deleteAfterRun: false,
      maxRuns: 2,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    });

    // Run 1
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    // Run 2 — should be disabled, not deleted
    vi.setSystemTime(new Date("2025-12-13T00:02:00.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && !item.enabled),
    );
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated).toBeDefined();
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.totalRuns).toBe(2);

    cron.stop();
    await store.cleanup();
  });

  it("counts all run statuses toward totalRuns", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    let callCount = 0;
    const runHeartbeatOnce = vi.fn(async () => {
      callCount++;
      // First call fails, second succeeds, third succeeds
      if (callCount === 1) {
        return { status: "failed" as const, reason: "boom" };
      }
      return { status: "ran" as const, durationMs: 1 };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-mixed",
      enabled: true,
      deleteAfterRun: true,
      maxRuns: 3,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check" },
    });

    // Run 1 (error)
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    let jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && item.state.totalRuns === 1),
    );
    let updated = jobs.find((j) => j.id === job.id);
    expect(updated?.state.totalRuns).toBe(1);
    expect(updated?.state.lastStatus).toBe("error");

    // Run 2 (ok) — need to advance past backoff
    vi.setSystemTime(new Date("2025-12-13T00:02:30.000Z"));
    await vi.runOnlyPendingTimersAsync();
    jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && item.state.totalRuns === 2),
    );
    updated = jobs.find((j) => j.id === job.id);
    expect(updated?.state.totalRuns).toBe(2);

    // Run 3 (ok) — should be deleted
    vi.setSystemTime(new Date("2025-12-13T00:03:30.000Z"));
    await vi.runOnlyPendingTimersAsync();
    jobs = await waitForJobs(cron, (items) => !items.some((item) => item.id === job.id));
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("preserves totalRuns in persisted state", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-persist",
      enabled: true,
      deleteAfterRun: true,
      maxRuns: 5,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    });

    // Run once
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && item.state.totalRuns === 1),
    );

    cron.stop();

    // Restart with scheduler disabled so it just loads from disk without firing
    const cron2 = new CronService({
      storePath: store.storePath,
      cronEnabled: false,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron2.start();
    const jobs = await cron2.list({ includeDisabled: true });
    const reloaded = jobs.find((j) => j.id === job.id);
    expect(reloaded?.state.totalRuns).toBe(1);
    expect(reloaded?.maxRuns).toBe(5);

    cron2.stop();
    await store.cleanup();
  });

  it("deletes after a single run when maxRuns is 1", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-single",
      enabled: true,
      deleteAfterRun: true,
      maxRuns: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check once" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await waitForJobs(cron, (items) => !items.some((item) => item.id === job.id));
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });

  it("deletes when maxRuns is reached without deleteAfterRun", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-no-flag",
      enabled: true,
      maxRuns: 2,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    });

    expect(job.deleteAfterRun).toBeUndefined();

    // Run 1
    vi.setSystemTime(new Date("2025-12-13T00:01:00.000Z"));
    await vi.runOnlyPendingTimersAsync();
    // Run 2 — should be deleted
    vi.setSystemTime(new Date("2025-12-13T00:02:00.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await waitForJobs(cron, (items) => !items.some((item) => item.id === job.id));
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("recurring job without maxRuns runs indefinitely", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const job = await cron.add({
      name: "max-runs-none",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "heartbeat" },
    });

    // Run 5 times — should still exist
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(new Date(`2025-12-13T00:0${i}:00.000Z`));
      await vi.runOnlyPendingTimersAsync();
    }

    const jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && (item.state.totalRuns ?? 0) >= 5),
    );
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated).toBeDefined();
    expect(updated?.state.totalRuns).toBe(5);

    cron.stop();
    await store.cleanup();
  });
});
