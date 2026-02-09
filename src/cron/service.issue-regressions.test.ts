import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { CronService } from "./service.js";
import { createCronServiceState, type CronEvent } from "./service/state.js";
import { onTimer } from "./service/timer.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-issues-"));
  const storePath = path.join(dir, "jobs.json");
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function createDueIsolatedJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
  deleteAfterRun?: boolean;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun ?? false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "at", at: new Date(params.nextRunAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.id },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

describe("Cron issue regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T10:05:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("recalculates nextRunAtMs when schedule changes", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const created = await cron.add({
      name: "hourly",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(created.state.nextRunAtMs).toBe(Date.parse("2026-02-06T11:00:00.000Z"));

    const updated = await cron.update(created.id, {
      schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2026-02-06T12:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("runs immediately with force mode even when not due", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const created = await cron.add({
      name: "force-now",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "force" },
    });

    const result = await cron.run(created.id, "force");

    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("force", { agentId: undefined });

    cron.stop();
    await store.cleanup();
  });

  it("schedules isolated jobs with next wake time", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const job = await cron.add({
      name: "isolated",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hi" },
    });
    const status = await cron.status();

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(typeof status.nextWakeAtMs).toBe("number");

    cron.stop();
    await store.cleanup();
  });

  it("persists allowUnsafeExternalContent on agentTurn payload patches", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const created = await cron.add({
      name: "unsafe toggle",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hi" },
    });

    const updated = await cron.update(created.id, {
      payload: { kind: "agentTurn", allowUnsafeExternalContent: true },
    });

    expect(updated.payload.kind).toBe("agentTurn");
    if (updated.payload.kind === "agentTurn") {
      expect(updated.payload.allowUnsafeExternalContent).toBe(true);
      expect(updated.payload.message).toBe("hi");
    }

    cron.stop();
    await store.cleanup();
  });

  it("caps timer delay to 60s for far-future schedules", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await cron.start();

    const callsBeforeAdd = timeoutSpy.mock.calls.length;
    await cron.add({
      name: "far-future",
      schedule: { kind: "at", at: "2035-01-01T00:00:00.000Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "future" },
    });

    const delaysAfterAdd = timeoutSpy.mock.calls
      .slice(callsBeforeAdd)
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delaysAfterAdd.some((delay) => delay === 60_000)).toBe(true);

    cron.stop();
    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("does not hot-loop zero-delay timers while a run is already in progress", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    state.running = true;
    state.store = {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "due", nowMs: now, nextRunAtMs: now - 1 })],
    };

    await onTimer(state);

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(state.timer).toBeNull();
    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("skips forced manual runs while a timer-triggered run is in progress", async () => {
    vi.useRealTimers();
    const store = await makeStorePath();
    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    const runIsolatedAgentJob = vi.fn(
      async () =>
        await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>(
          (resolve) => {
            resolveRun = resolve;
          },
        ),
    );

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();

    const runAt = Date.now() + 30;
    const job = await cron.add({
      name: "timer-overlap",
      enabled: true,
      schedule: { kind: "at", at: new Date(runAt).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "long task" },
      delivery: { mode: "none" },
    });

    for (let i = 0; i < 25 && runIsolatedAgentJob.mock.calls.length === 0; i++) {
      await delay(20);
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const manualResult = await cron.run(job.id, "force");
    expect(manualResult).toEqual({ ok: true, ran: false, reason: "already-running" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    resolveRun?.({ status: "ok", summary: "done" });
    for (let i = 0; i < 25; i++) {
      const jobs = await cron.list({ includeDisabled: true });
      if (jobs.some((j) => j.id === job.id && j.state.lastStatus === "ok")) {
        break;
      }
      await delay(20);
    }

    cron.stop();
    await store.cleanup();
  });

  it("records per-job start time and duration for batched due jobs", async () => {
    const store = await makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "batch-first", nowMs: dueAt, nextRunAtMs: dueAt });
    const second = createDueIsolatedJob({ id: "batch-second", nowMs: dueAt, nextRunAtMs: dueAt });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [first, second] }, null, 2),
      "utf-8",
    );

    let now = dueAt;
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      onEvent: (evt) => {
        events.push(evt);
      },
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        now += params.job.id === first.id ? 50 : 20;
        return { status: "ok" as const, summary: "ok" };
      }),
    });

    await onTimer(state);

    const jobs = state.store?.jobs ?? [];
    const firstDone = jobs.find((job) => job.id === first.id);
    const secondDone = jobs.find((job) => job.id === second.id);
    const startedAtEvents = events
      .filter((evt) => evt.action === "started")
      .map((evt) => evt.runAtMs);

    expect(firstDone?.state.lastRunAtMs).toBe(dueAt);
    expect(firstDone?.state.lastDurationMs).toBe(50);
    expect(secondDone?.state.lastRunAtMs).toBe(dueAt + 50);
    expect(secondDone?.state.lastDurationMs).toBe(20);
    expect(startedAtEvents).toEqual([dueAt, dueAt + 50]);

    await store.cleanup();
  });
});
