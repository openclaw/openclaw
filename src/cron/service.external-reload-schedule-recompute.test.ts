import fs from "node:fs";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import {
  hasSkipNextReloadRepairRecompute,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
} from "./service/jobs.js";
import { run } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { onTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-external-reload-",
  baseTimeIso: "2026-03-19T01:44:00.000Z",
});

function createCronJob(params: {
  id: string;
  expr: string;
  updatedAtMs?: number;
  enabled?: boolean;
  nextRunAtMs?: number;
  scheduleErrorCount?: number;
  lastError?: string;
  lastStatus?: CronJob["state"]["lastStatus"];
  runningAtMs?: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: params.enabled ?? true,
    createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
    updatedAtMs: params.updatedAtMs ?? Date.parse("2026-03-19T01:44:00.000Z"),
    schedule: { kind: "cron", expr: params.expr, tz: "Asia/Shanghai", staggerMs: 0 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {
      nextRunAtMs: params.nextRunAtMs,
      scheduleErrorCount: params.scheduleErrorCount,
      lastError: params.lastError,
      lastStatus: params.lastStatus,
      runningAtMs: params.runningAtMs,
    },
  };
}

describe("forceReload repairs externally changed schedules", () => {
  it("recomputes nextRunAtMs when jobs.json changes a cron schedule outside cron.update", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "external-schedule-change";
    const staleNextRunAtMs = Date.parse("2026-03-20T00:30:00.000Z");
    const correctedNextRunAtMs = Date.parse("2026-03-19T12:30:00.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createCronJob({ id: jobId, expr: "30 8 * * *", nextRunAtMs: staleNextRunAtMs })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createCronJob({ id: jobId, expr: "30 8,20 * * *", nextRunAtMs: staleNextRunAtMs })],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloaded = state.store?.jobs.find((job) => job.id === jobId);
    expect(reloaded?.state.nextRunAtMs).toBe(correctedNextRunAtMs);

    const persisted = JSON.parse(await fsp.readFile(store.storePath, "utf8")) as {
      jobs?: Array<{ id: string; state?: { nextRunAtMs?: number } }>;
    };
    expect(persisted.jobs?.find((job) => job.id === jobId)?.state?.nextRunAtMs).toBe(
      correctedNextRunAtMs,
    );
  });

  it("recomputes from updatedAtMs so delayed reload keeps newly earlier slots due", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-schedule-change-delayed-observe";
    const staleNextRunAtMs = Date.parse("2026-03-20T00:30:00.000Z");

    const createJob = (params: { expr: string; updatedAtMs: number }) =>
      createCronJob({
        id: jobId,
        expr: params.expr,
        updatedAtMs: params.updatedAtMs,
        nextRunAtMs: staleNextRunAtMs,
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createJob({ expr: "30 23 * * *", updatedAtMs: Date.parse("2026-03-19T12:00:00.000Z") }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ expr: "* * * * *", updatedAtMs: Date.parse("2026-03-19T12:01:00.000Z") })],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:02:00.000Z"));
  });

  it("recomputes pure enable reloads from now instead of the older edit time", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-enable-delayed-observe";

    const createJob = (params: { enabled: boolean; updatedAtMs: number }) =>
      createCronJob({
        id: jobId,
        expr: "* * * * *",
        enabled: params.enabled,
        updatedAtMs: params.updatedAtMs,
        nextRunAtMs: undefined,
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ enabled: false, updatedAtMs: Date.parse("2026-03-19T12:00:00.000Z") })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ enabled: true, updatedAtMs: Date.parse("2026-03-19T12:01:00.000Z") })],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:11:00.000Z"));
  });

  it("recomputes enable plus schedule reloads from now instead of the older edit time", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-enable-and-schedule-delayed-observe";

    const createJob = (params: { enabled: boolean; expr: string; updatedAtMs: number }) =>
      createCronJob({
        id: jobId,
        expr: params.expr,
        enabled: params.enabled,
        updatedAtMs: params.updatedAtMs,
        nextRunAtMs: undefined,
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createJob({
          enabled: false,
          expr: "30 23 * * *",
          updatedAtMs: Date.parse("2026-03-19T12:00:00.000Z"),
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createJob({
          enabled: true,
          expr: "* * * * *",
          updatedAtMs: Date.parse("2026-03-19T12:01:00.000Z"),
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:11:00.000Z"));
  });

  it("does not repair when a cron rewrite only changes equivalent defaults", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T09:00:00.000Z");
    const jobId = "external-equivalent-cron-rewrite";
    const dueNextRunAtMs = Date.parse("2026-03-19T08:30:00.000Z");

    const baseJob = (params: { updatedAtMs: number; tz?: string; staggerMs?: number }) =>
      ({
        id: jobId,
        name: jobId,
        enabled: true,
        createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
        updatedAtMs: params.updatedAtMs,
        schedule: {
          kind: "cron" as const,
          expr: "30 8 * * *",
          ...(params.tz !== undefined ? { tz: params.tz } : {}),
          ...(params.staggerMs !== undefined ? { staggerMs: params.staggerMs } : {}),
        },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "systemEvent" as const, text: "tick" },
        state: {
          nextRunAtMs: dueNextRunAtMs,
        },
      }) satisfies CronJob;

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [baseJob({ updatedAtMs: Date.parse("2026-03-19T08:00:00.000Z") })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        baseJob({
          updatedAtMs: Date.parse("2026-03-19T08:45:00.000Z"),
          tz: "   ",
          staggerMs: 0,
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("does not repair when a cron rewrite only materializes the local timezone", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T09:00:00.000Z");
    const jobId = "external-equivalent-local-timezone-rewrite";
    const dueNextRunAtMs = computeNextRunAtMs(
      { kind: "cron", expr: "*/10 * * * *" },
      Date.parse("2026-03-19T08:40:00.000Z"),
    );
    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(dueNextRunAtMs).toBeDefined();
    expect(localTimezone).toBeTruthy();

    const baseJob = (params: { updatedAtMs: number; tz?: string }) =>
      ({
        id: jobId,
        name: jobId,
        enabled: true,
        createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
        updatedAtMs: params.updatedAtMs,
        schedule: {
          kind: "cron" as const,
          expr: "*/10 * * * *",
          ...(params.tz !== undefined ? { tz: params.tz } : {}),
        },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "systemEvent" as const, text: "tick" },
        state: {
          nextRunAtMs: dueNextRunAtMs,
        },
      }) satisfies CronJob;

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [baseJob({ updatedAtMs: Date.parse("2026-03-19T08:40:00.000Z") })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        baseJob({
          updatedAtMs: Date.parse("2026-03-19T08:55:00.000Z"),
          tz: localTimezone,
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("does not repair when a cron rewrite only changes cron token casing", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T13:00:00.000Z");
    const jobId = "external-equivalent-cron-case-rewrite";
    const dueNextRunAtMs = Date.parse("2026-03-19T12:00:00.000Z");

    const baseJob = (params: { updatedAtMs: number; expr: string }) =>
      ({
        id: jobId,
        name: jobId,
        enabled: true,
        createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
        updatedAtMs: params.updatedAtMs,
        schedule: {
          kind: "cron" as const,
          expr: params.expr,
          tz: "UTC",
          staggerMs: 0,
        },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "systemEvent" as const, text: "tick" },
        state: {
          nextRunAtMs: dueNextRunAtMs,
        },
      }) satisfies CronJob;

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        baseJob({ updatedAtMs: Date.parse("2026-03-19T12:00:00.000Z"), expr: "0 12 * * MON" }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        baseJob({ updatedAtMs: Date.parse("2026-03-19T12:30:00.000Z"), expr: "0 12 * * mon" }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("does not repair when a cron rewrite only changes an equivalent timezone spelling", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T13:00:00.000Z");
    const jobId = "external-equivalent-cron-timezone-rewrite";
    const dueNextRunAtMs = Date.parse("2026-03-19T12:00:00.000Z");

    const baseJob = (params: { updatedAtMs: number; tz: string }) =>
      ({
        id: jobId,
        name: jobId,
        enabled: true,
        createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
        updatedAtMs: params.updatedAtMs,
        schedule: {
          kind: "cron" as const,
          expr: "0 12 * * *",
          tz: params.tz,
          staggerMs: 0,
        },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "systemEvent" as const, text: "tick" },
        state: {
          nextRunAtMs: dueNextRunAtMs,
        },
      }) satisfies CronJob;

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [baseJob({ updatedAtMs: Date.parse("2026-03-19T12:00:00.000Z"), tz: "utc" })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [baseJob({ updatedAtMs: Date.parse("2026-03-19T12:30:00.000Z"), tz: "UTC" })],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("falls back to file mtime when external edits keep updatedAtMs unchanged", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-schedule-change-unchanged-updatedAt";
    const staleNextRunAtMs = Date.parse("2026-03-20T00:30:00.000Z");
    const updatedAtMs = Date.parse("2026-03-19T12:00:00.000Z");
    const fileEditMtimeMs = Date.parse("2026-03-19T12:01:00.000Z");
    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = vi.spyOn(fs.promises, "stat");
    let statCallCount = 0;
    statSpy.mockImplementation(async (...args) => {
      const stats = await realStat(...args);
      return Object.assign(stats, {
        mtimeMs: statCallCount++ === 0 ? updatedAtMs : fileEditMtimeMs,
      });
    });

    const createJob = (expr: string) =>
      createCronJob({
        id: jobId,
        expr,
        updatedAtMs,
        nextRunAtMs: staleNextRunAtMs,
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob("30 23 * * *")],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob("* * * * *")],
    });

    try {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });

      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:02:00.000Z"));
    } finally {
      statSpy.mockRestore();
    }
  });

  it("falls back to file mtime when external edits drop updatedAtMs", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-schedule-change-missing-updatedAt";
    const staleNextRunAtMs = Date.parse("2026-03-20T00:30:00.000Z");
    const initialUpdatedAtMs = Date.parse("2026-03-19T12:00:00.000Z");
    const fileEditMtimeMs = Date.parse("2026-03-19T12:01:00.000Z");
    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = vi.spyOn(fs.promises, "stat");
    let statCallCount = 0;
    statSpy.mockImplementation(async (...args) => {
      const stats = await realStat(...args);
      return Object.assign(stats, {
        mtimeMs: statCallCount++ === 0 ? initialUpdatedAtMs : fileEditMtimeMs,
      });
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "30 23 * * *",
          updatedAtMs: initialUpdatedAtMs,
          nextRunAtMs: staleNextRunAtMs,
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await fsp.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              ...createCronJob({
                id: jobId,
                expr: "* * * * *",
                updatedAtMs: initialUpdatedAtMs,
                nextRunAtMs: staleNextRunAtMs,
              }),
              updatedAtMs: "not-a-number",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });

      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:02:00.000Z"));
    } finally {
      statSpy.mockRestore();
    }
  });

  it("records schedule errors instead of aborting reload when an external edit is invalid", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "external-invalid-schedule";

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "30 8 * * *",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "not a valid cron",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    await expect(
      ensureLoaded(state, { forceReload: true, skipRecompute: true }),
    ).resolves.toBeUndefined();

    const reloaded = state.store?.jobs[0];
    expect(reloaded?.state.nextRunAtMs).toBeUndefined();
    expect(reloaded?.state.scheduleErrorCount).toBe(1);
    expect(reloaded?.state.lastError).toMatch(/^schedule error:/);
  });

  it("records a cron-specific error when an external reload clears cron expr", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "external-blank-cron-expr";

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "30 8 * * *",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "   ",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloaded = state.store?.jobs[0];
    expect(reloaded?.state.scheduleErrorCount).toBe(1);
    expect(reloaded?.state.lastError).toBe(
      "schedule error: Error: invalid cron schedule: expr is required",
    );
  });

  it("preserves schedule error count when an external reload only disables an invalid job", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T09:00:00.000Z");
    const jobId = "external-disable-invalid-job";

    const createJob = (params: { updatedAtMs: number; enabled: boolean }) =>
      createCronJob({
        id: jobId,
        expr: "   ",
        enabled: params.enabled,
        updatedAtMs: params.updatedAtMs,
        nextRunAtMs: undefined,
        scheduleErrorCount: 2,
        lastError: "schedule error: invalid cron schedule: expr is required",
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ updatedAtMs: Date.parse("2026-03-19T08:40:00.000Z"), enabled: true })],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ updatedAtMs: Date.parse("2026-03-19T08:55:00.000Z"), enabled: false })],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloaded = state.store?.jobs[0];
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.state.scheduleErrorCount).toBe(2);
    expect(reloaded?.state.nextRunAtMs).toBeUndefined();
  });

  it("does not double-count a reload schedule error during the immediate recompute", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "external-invalid-schedule-full-recompute";

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "30 8 * * *",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "not a valid cron",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    expect(state.store?.jobs[0]?.state.scheduleErrorCount).toBe(1);

    recomputeNextRuns(state);
    expect(state.store?.jobs[0]?.state.scheduleErrorCount).toBe(1);
  });

  it("keeps forceReload repairs when manual-run snapshot is merged back", async () => {
    const store = await makeStorePath();
    let nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "manual-run-reload-merge";
    const staleNextRunAtMs = Date.parse("2026-03-19T23:30:00.000Z");

    const createJob = (params: { expr: string; enabled: boolean; nextRunAtMs?: number }) => ({
      ...createCronJob({
        id: jobId,
        expr: params.expr,
        enabled: params.enabled,
        nextRunAtMs: params.nextRunAtMs,
      }),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn", message: "tick" } as const,
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob({ expr: "30 23 * * *", enabled: true, nextRunAtMs: staleNextRunAtMs })],
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [createJob({ expr: "30 8 * * *", enabled: false, nextRunAtMs: staleNextRunAtMs })],
      });
      nowMs += 500;
      return { status: "ok" as const, summary: "done" };
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    expect(await run(state, jobId, "force")).toEqual({ ok: true, ran: true });

    const merged = state.store?.jobs[0];
    expect(merged?.enabled).toBe(false);
    expect(merged?.state.nextRunAtMs).toBeUndefined();
    expect(merged?.state.lastStatus).toBe("ok");
  });

  it("keeps scheduleErrorCount cleared when external reload fixes schedule during force-run", async () => {
    const store = await makeStorePath();
    let nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "manual-run-reload-clears-schedule-error-count";
    const staleNextRunAtMs = Date.parse("2026-03-19T23:30:00.000Z");

    const createJob = (expr: string) => ({
      ...createCronJob({
        id: jobId,
        expr,
        nextRunAtMs: staleNextRunAtMs,
        scheduleErrorCount: 2,
        lastError: "schedule error: invalid expression",
      }),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn", message: "tick" } as const,
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob("30 23 * * *")],
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [createJob("30 8 * * *")],
      });
      nowMs += 500;
      return { status: "ok" as const, summary: "done" };
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    expect(await run(state, jobId, "force")).toEqual({ ok: true, ran: true });
    expect(state.store?.jobs[0]?.state.scheduleErrorCount).toBeUndefined();
    expect(state.store?.jobs[0]?.state.lastError).toBeUndefined();
  });

  it("does not persist NaN updatedAtMs when manual-run reload sees an invalid timestamp", async () => {
    const store = await makeStorePath();
    let nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "manual-run-reload-invalid-updatedAt";

    const createJob = () => ({
      ...createCronJob({
        id: jobId,
        expr: "30 23 * * *",
        updatedAtMs: Date.parse("2026-03-19T01:44:00.000Z"),
        nextRunAtMs: Date.parse("2026-03-19T23:30:00.000Z"),
      }),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn", message: "tick" } as const,
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob()],
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      await fsp.writeFile(
        store.storePath,
        JSON.stringify(
          {
            version: 1,
            jobs: [
              {
                ...createJob(),
                updatedAtMs: "not-a-number",
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      nowMs += 500;
      return { status: "ok" as const, summary: "done" };
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    expect(await run(state, jobId, "force")).toEqual({ ok: true, ran: true });
    expect(Number.isFinite(state.store?.jobs[0]?.updatedAtMs)).toBe(true);
    const persisted = JSON.parse(await fsp.readFile(store.storePath, "utf8")) as {
      jobs?: Array<{ updatedAtMs?: unknown }>;
    };
    expect(typeof persisted.jobs?.[0]?.updatedAtMs).toBe("number");
  });

  it("preserves unrelated reload-skip markers through manual-run cleanup", async () => {
    const store = await makeStorePath();
    let nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const manualJobId = "manual-run-preserves-other-skip-marker";
    const invalidJobId = "manual-run-other-invalid-reload";

    const createManualJob = (): CronJob => ({
      ...createCronJob({
        id: manualJobId,
        expr: "30 23 * * *",
        nextRunAtMs: Date.parse("2026-03-19T23:30:00.000Z"),
      }),
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "tick" },
    });

    const createInvalidJob = (expr: string): CronJob =>
      createCronJob({
        id: invalidJobId,
        expr,
        nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createManualJob(), createInvalidJob("30 8 * * *")],
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [createManualJob(), createInvalidJob("not a valid cron")],
      });
      nowMs += 500;
      return { status: "ok" as const, summary: "done" };
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    expect(await run(state, manualJobId, "force")).toEqual({ ok: true, ran: true });

    const invalidJob = state.store?.jobs.find((job) => job.id === invalidJobId);
    expect(invalidJob?.state.scheduleErrorCount).toBe(1);
    expect(hasSkipNextReloadRepairRecompute(state, invalidJobId)).toBe(true);

    recomputeNextRunsForMaintenance(state);

    expect(state.store?.jobs.find((job) => job.id === invalidJobId)?.state.scheduleErrorCount).toBe(
      1,
    );
  });

  it("preserves unrelated reload-skip markers through timer post-run cleanup", async () => {
    const store = await makeStorePath();
    let nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const runningJobId = "timer-run-preserves-other-skip-marker";
    const invalidJobId = "timer-run-other-invalid-reload";

    const createRunningJob = (): CronJob => ({
      ...createCronJob({
        id: runningJobId,
        expr: "30 23 * * *",
        nextRunAtMs: nowMs,
      }),
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "tick" },
    });

    const createInvalidJob = (expr: string): CronJob =>
      createCronJob({
        id: invalidJobId,
        expr,
        nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
      });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createRunningJob(), createInvalidJob("30 8 * * *")],
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      await writeCronStoreSnapshot({
        storePath: store.storePath,
        jobs: [createRunningJob(), createInvalidJob("not a valid cron")],
      });
      nowMs += 500;
      return { status: "ok" as const, summary: "done" };
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const invalidJob = state.store?.jobs.find((job) => job.id === invalidJobId);
    expect(invalidJob?.state.scheduleErrorCount).toBe(1);
    expect(hasSkipNextReloadRepairRecompute(state, invalidJobId)).toBe(true);

    recomputeNextRunsForMaintenance(state);

    expect(state.store?.jobs.find((job) => job.id === invalidJobId)?.state.scheduleErrorCount).toBe(
      1,
    );
  });

  it("preserves runningAtMs when an external reload comes from a stale file snapshot", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-running-marker";
    const runningAtMs = Date.parse("2026-03-19T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "30 23 * * *",
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
          runningAtMs,
        }),
      ],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        createCronJob({
          id: jobId,
          expr: "* * * * *",
          updatedAtMs: Date.parse("2026-03-19T12:01:00.000Z"),
          nextRunAtMs: Date.parse("2026-03-20T00:30:00.000Z"),
          runningAtMs: runningAtMs - 60_000,
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloaded = state.store?.jobs[0];
    expect(reloaded?.state.runningAtMs).toBe(runningAtMs);
    expect(reloaded?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T12:02:00.000Z"));
  });

  it("keeps runningAtMs when an external reload disables a still-running job", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T12:10:00.000Z");
    const jobId = "external-disable-running-job";
    const runningAtMs = Date.parse("2026-03-19T12:00:00.000Z");

    const createJob = (enabled: boolean): CronJob => ({
      id: jobId,
      name: jobId,
      enabled,
      createdAtMs: Date.parse("2026-03-18T00:30:00.000Z"),
      updatedAtMs: Date.parse("2026-03-19T12:01:00.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        nextRunAtMs: Date.parse("2026-03-19T12:11:00.000Z"),
        runningAtMs,
      },
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob(true)],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createJob(false)],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.enabled).toBe(false);
    expect(state.store?.jobs[0]?.state.runningAtMs).toBe(runningAtMs);
    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
  });

  it("recomputes nextRunAtMs when an external every schedule changes", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-03-19T01:44:00.000Z");
    const jobId = "external-every-schedule-change";

    const createEveryJob = (everyMs: number): CronJob => ({
      id: jobId,
      name: jobId,
      enabled: true,
      createdAtMs: Date.parse("2026-03-18T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-03-19T01:44:00.000Z"),
      schedule: {
        kind: "every",
        everyMs,
        anchorMs: Date.parse("2026-03-19T00:00:00.000Z"),
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        nextRunAtMs: Date.parse("2026-03-20T00:00:00.000Z"),
      },
    });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createEveryJob(6 * 60_000)],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await ensureLoaded(state, { skipRecompute: true });

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [createEveryJob(60_000)],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-03-19T01:44:00.000Z"));
  });
});
