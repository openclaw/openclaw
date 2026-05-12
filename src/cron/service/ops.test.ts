import { describe, expect, it, vi } from "vitest";
import * as detachedTaskRuntime from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { run, start, stop, update } from "./ops.js";
import { createCronServiceState } from "./state.js";
import { runMissedJobs } from "./timer.js";

const { logger, makeStoreKey } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

function withStateDir(stateDir: string) {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests();
  return () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  };
}

function createTimedOutIsolatedCronState(params: { storeKey: string; now: number }) {
  return createCronServiceState({
    storeKey: params.storeKey,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => {
      throw new Error("cron: job execution timed out");
    }),
  });
}

function createOkIsolatedCronState(params: { storeKey: string; now: number; summary?: string }) {
  return createCronServiceState({
    storeKey: params.storeKey,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      ...(params.summary === undefined ? {} : { summary: params.summary }),
    })),
  });
}

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
    },
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    id: "isolated-timeout",
    name: "isolated timeout",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

async function writeDueIsolatedJobSnapshot(storeKey: string, now: number) {
  await writeCronStoreSnapshot({
    storeKey,
    jobs: [createDueIsolatedJob(now)],
  });
}

async function expectDueIsolatedManualRunProgresses(storeKey: string, now: number) {
  const state = createOkIsolatedCronState({ storeKey, now, summary: "done" });

  await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

  const persisted = (await loadCronStore(storeKey)) as {
    jobs: CronJob[];
  };
  expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
}

function expectWarnedJob(params: { field: "jobId" | "jobStatus"; value: string; message: string }) {
  const warnCalls = logger.warn.mock.calls as unknown as Array<[Record<string, unknown>, string]>;
  const warning = warnCalls.find(
    ([metadata, message]) => metadata[params.field] === params.value && message === params.message,
  );
  expect(warning?.[0][params.field]).toBe(params.value);
  expect(warning?.[1]).toBe(params.message);
}

function expectTaskRun(params: {
  runId: string;
  runtime: string;
  status: string;
  sourceId: string;
}) {
  const task = findTaskByRunId(params.runId);
  expect(task?.runtime).toBe(params.runtime);
  expect(task?.status).toBe(params.status);
  expect(task?.sourceId).toBe(params.sourceId);
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    id: "startup-timeout",
    name: "startup timeout",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "should timeout" },
    sessionKey: "agent:main:main",
    state: {
      nextRunAtMs: now - 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("start marks interrupted running jobs failed, persists, and arms the timer", async () => {
    const { storeKey } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storeKey,
      jobs: [createInterruptedMainJob(now)],
    });

    const state = createCronServiceState({
      storeKey,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expectWarnedJob({
      field: "jobId",
      value: "startup-interrupted",
      message: "cron: marking interrupted running job failed on startup",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(state.timer).toBeDefined();

    const persisted = (await loadCronStore(storeKey)) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted cron job");
    }
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.lastRunStatus).toBe("error");
    expect(job.state.lastRunAtMs).toBe(now - 30 * 60_000);
    expect(job.state.lastError).toBe("cron: job interrupted by gateway restart");
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("start persists load-time updatedAtMs repairs to SQLite state only", async () => {
    const { storeKey } = await makeStoreKey();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const createdAtMs = now - 86_400_000;
    const persistedAtMs = Date.now();
    const nextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");
    const jobId = "future-sidecar-repair";
    await writeCronStoreSnapshot({
      storeKey,
      jobs: [
        {
          id: jobId,
          name: "future state repair",
          enabled: true,
          createdAtMs,
          updatedAtMs: undefined,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs },
        } as unknown as CronJob,
      ],
    });

    const state = createCronServiceState({
      storeKey,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await start(state);

      const persisted = await loadCronStore(storeKey);

      expect(persisted.jobs[0]?.updatedAtMs).toBe(persistedAtMs);
      expect(persisted.jobs[0]?.state.nextRunAtMs).toBe(nextRunAtMs);
    } finally {
      stop(state);
    }
  });

  it("keeps manual acknowledgement IDs separate from recoverable task run IDs", async () => {
    const { storeKey, stateDir } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDir(stateDir);

    try {
      await writeDueIsolatedJobSnapshot(storeKey, now);

      const state = createOkIsolatedCronState({ storeKey, now, summary: "done" });
      const manualRunId = `manual:isolated-timeout:${now}:1`;

      await expect(
        run(state, "isolated-timeout", "force", { runId: manualRunId }),
      ).resolves.toEqual({
        ok: true,
        ran: true,
      });

      expectTaskRun({
        runId: `cron:isolated-timeout:${now}`,
        runtime: "cron",
        status: "succeeded",
        sourceId: "isolated-timeout",
      });
      expect(findTaskByRunId(manualRunId)).toBeUndefined();
    } finally {
      restoreStateDir();
    }
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storeKey, stateDir } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDir(stateDir);

    try {
      await writeDueIsolatedJobSnapshot(storeKey, now);

      const state = createTimedOutIsolatedCronState({
        storeKey,
        now,
      });

      await run(state, "isolated-timeout");

      expectTaskRun({
        runId: `cron:isolated-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "isolated-timeout",
      });
    } finally {
      restoreStateDir();
    }
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storeKey } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storeKey,
      jobs: [createDueIsolatedJob(now)],
    });

    const createTaskRecordSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    await expectDueIsolatedManualRunProgresses(storeKey, now);
    expectWarnedJob({
      field: "jobId",
      value: "isolated-timeout",
      message: "cron: failed to create task ledger record",
    });

    createTaskRecordSpy.mockRestore();
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storeKey, stateDir } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDir(stateDir);

    try {
      await writeDueIsolatedJobSnapshot(storeKey, now);

      const updateTaskRecordSpy = vi
        .spyOn(detachedTaskRuntime, "completeTaskRunByRunId")
        .mockImplementation(() => {
          throw new Error("disk full");
        });

      try {
        await expectDueIsolatedManualRunProgresses(storeKey, now);
        expectWarnedJob({
          field: "jobStatus",
          value: "ok",
          message: "cron: failed to update task ledger record",
        });
      } finally {
        updateTaskRecordSpy.mockRestore();
      }
    } finally {
      restoreStateDir();
    }
  });

  it("non-schedule edit preserves nextRunAtMs (#63499)", async () => {
    const { storeKey } = await makeStoreKey();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const originalNextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");

    await writeCronStoreSnapshot({
      storeKey,
      jobs: [
        {
          id: "daily-report",
          name: "daily report",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "daily" },
          state: { nextRunAtMs: originalNextRunAtMs },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storeKey, now });

    const updated = await update(state, "daily-report", { description: "edited" });

    expect(updated.description).toBe("edited");
    expect(updated.state.nextRunAtMs).toBe(originalNextRunAtMs);
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storeKey } = await makeStoreKey();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      storeKey,
      jobs: [
        {
          id: "broken-job",
          name: "broken",
          enabled: true,
          createdAtMs: now - 86_400_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
          state: { nextRunAtMs: 0 },
        },
      ],
    });

    const state = createOkIsolatedCronState({ storeKey, now });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storeKey, stateDir } = await makeStoreKey();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const restoreStateDir = withStateDir(stateDir);

    try {
      await writeCronStoreSnapshot({
        storeKey,
        jobs: [createMissedIsolatedJob(now)],
      });

      const state = createTimedOutIsolatedCronState({
        storeKey,
        now,
      });

      await runMissedJobs(state);

      expectTaskRun({
        runId: `cron:startup-timeout:${now}`,
        runtime: "cron",
        status: "timed_out",
        sourceId: "startup-timeout",
      });
    } finally {
      restoreStateDir();
    }
  });
});
