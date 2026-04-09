import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { run, start, stop } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

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

function createInterruptedOneShotJob(now: number): CronJob {
  // One-shot (`kind: "at"`) job that was mid-execution when the gateway
  // went down: `runningAtMs` is set but `lastStatus` is unset because the
  // run never reached the settle step. See #63657.
  return {
    id: "startup-interrupted-one-shot",
    name: "startup interrupted one-shot",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "at", at: new Date(now - 60_000).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "one-shot reminder" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
    },
  };
}

function createCompletedOneShotJob(now: number): CronJob {
  // One-shot that already settled successfully before the restart. The
  // `runningAtMs` marker is stale (should have been cleared by timer.ts:408
  // in the same block that set `lastStatus`), but defensive code should
  // still treat it as completed and refuse to re-run it.
  return {
    id: "startup-completed-one-shot",
    name: "startup completed one-shot",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "at", at: new Date(now - 3_600_000).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "already delivered" },
    state: {
      nextRunAtMs: now - 3_600_000,
      lastRunAtMs: now - 3_600_000,
      lastStatus: "ok",
      // Stale runningAtMs to simulate a crash between marker set and clear.
      runningAtMs: now - 3_600_000,
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
  it("start clears stale running markers, replays interrupted recurring jobs, persists, and arms the timer (#60495)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedMainJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-interrupted" }),
      "cron: clearing stale running marker on startup",
    );
    // Interrupted recurring jobs are now replayed on first restart (#60495)
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalled();
    expect(state.timer).not.toBeNull();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect((job?.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("replays interrupted one-shot jobs on startup recovery (#63657)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedOneShotJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-interrupted-one-shot" }),
      "cron: clearing stale running marker on startup",
    );
    // Interrupted one-shot jobs must now be replayed on first restart —
    // previously they were silently skipped, losing any reminder or
    // scheduled delivery that happened to be mid-flight at the restart
    // moment (#63657).
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalled();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastRunAtMs).toBe(now);

    stop(state);
  });

  it("does not re-run a completed one-shot with stale runningAtMs on startup (#63657)", async () => {
    // Safety guard: if a crash leaves a completed one-shot with a stale
    // `runningAtMs` marker (e.g. the gateway died between the settle write
    // and the state flush), the `skipAtIfAlreadyRan` guard in
    // `runMissedJobs -> isRunnableJob` must still refuse to re-run it
    // because `lastStatus` is already set. Without this guarantee, fixing
    // #63657 would regress the #56509 class of one-shot double-delivery
    // bugs. See timer.ts:850-866.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createCompletedOneShotJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    // Startup still clears the stale marker.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-completed-one-shot" }),
      "cron: clearing stale running marker on startup",
    );
    // But the already-delivered one-shot is NOT re-enqueued.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    // Completion state is preserved — still "ok", still the original lastRun.
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastRunAtMs).toBe(now - 3_600_000);

    stop(state);
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("cron: job execution timed out");
      }),
    });

    await run(state, "isolated-timeout");

    expect(findTaskByRunId(`cron:isolated-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      status: "timed_out",
      sourceId: "isolated-timeout",
    });

    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });

    await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
    expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "isolated-timeout" }),
      "cron: failed to create task ledger record",
    );

    createTaskRecordSpy.mockRestore();
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedJob(now)],
    });

    const updateTaskRecordSpy = vi
      .spyOn(taskExecutor, "completeTaskRunByRunId")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });

    await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
    expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobStatus: "ok" }),
      "cron: failed to update task ledger record",
    );

    updateTaskRecordSpy.mockRestore();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMissedIsolatedJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("cron: job execution timed out");
      }),
    });

    await start(state);

    expect(findTaskByRunId(`cron:startup-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      status: "timed_out",
      sourceId: "startup-timeout",
    });

    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
    stop(state);
  });
});
