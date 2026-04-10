import nodeFs from "node:fs";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { jobExists, onTimer } from "../../cron/service/timer.js";
import type { CronJob } from "../../cron/types.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { remove } from "./ops.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: params.now - 1 },
  };
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
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

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: "agent:main:main",
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "cron:main-heartbeat-job",
      agentId: undefined,
      sessionKey: "agent:main:main",
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.nextRunAtMs).toBe(now + 60_000);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
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
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "main-heartbeat-job" }),
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      sessionKey: "agent:main:main",
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});

describe("jobExists", () => {
  it("returns true for a job present in the in-memory store", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // Use jobExists itself -- it triggers ensureLoaded via the lock chain.
    const exists = await jobExists(state, "main-heartbeat-job");
    expect(exists).toBe(true);
  });

  it("returns false for a job not in the store", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // Force store load
    await jobExists(state, "main-heartbeat-job");

    const exists = await jobExists(state, "nonexistent-job-id");
    expect(exists).toBe(false);
  });

  it("returns false when the store has no jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({ storePath, jobs: [] });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const exists = await jobExists(state, "any-id");
    expect(exists).toBe(false);
  });

  it("reflects in-memory removal without disk reload", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // Initially present
    expect(await jobExists(state, "main-heartbeat-job")).toBe(true);

    // Remove via the ops.remove path (updates in-memory store through lock)
    await remove(state, "main-heartbeat-job");

    // Should now be false -- no disk reload needed
    expect(await jobExists(state, "main-heartbeat-job")).toBe(false);
  });
});

describe("pre-execution job removal check in onTimer", () => {
  it("skips execution when job is removed on disk between collection and start", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "removed-before-exec",
          name: "removed before exec",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "should not run" },
          sessionKey: "agent:main:main",
          state: { nextRunAtMs: now - 1 },
        },
      ],
    });

    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "should not be called",
    }));
    const onEvent = vi.fn();

    // Simulate a cross-service race: onTimer collects due jobs and persists
    // running markers; before runDueJob executes, another service rewrites
    // the cron store on disk and removes the job.
    //
    // We trigger the external write during runDueJob's first nowMs() call
    // (startedAt) once we can confirm the collection phase already ran by
    // checking that runningAtMs was set in memory.
    let removeTriggered = false;
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => {
        if (state.store && state.store.jobs.length > 0 && !removeTriggered) {
          const job = state.store.jobs.find((j) => j.id === "removed-before-exec");
          if (job?.state.runningAtMs !== undefined) {
            removeTriggered = true;
            // Equivalent to an independent service persisting deletion.
            nodeFs.writeFileSync(
              storePath,
              `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`,
              "utf8",
            );
          }
        }
        return now;
      },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      onEvent,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "removed-before-exec", jobName: "removed before exec" }),
      "cron: skipping execution for job removed before start",
    );
    // jobExists(forceReload) should have observed the external disk write.
    expect(state.store?.jobs).toEqual([]);
    // No misleading started event should be emitted for a removed job.
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "removed-before-exec", action: "started" }),
    );
  });

  it("proceeds with execution when job still exists", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "still-exists-timer",
          name: "still exists timer",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "work" },
          sessionKey: "agent:main:main",
          state: { nextRunAtMs: now - 1 },
        },
      ],
    });

    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "completed normally",
    }));

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    // Job was executed normally
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    const job = state.store?.jobs.find((j) => j.id === "still-exists-timer");
    expect(job).toBeDefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.runningAtMs).toBeUndefined();

    // The skip log message should NOT have been emitted
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "still-exists-timer" }),
      "cron: skipping execution for job removed before start",
    );
  });

  it("existing applyOutcomeToStoredJob handles post-execution removal gracefully", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "removed-post-exec",
          name: "removed post exec",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "finish later" },
          sessionKey: "agent:main:main",
          state: { nextRunAtMs: now - 1 },
        },
      ],
    });

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    const runIsolatedAgentJob = vi.fn(async () => {
      markStarted?.();
      return await new Promise<{ status: "ok"; summary: string }>((resolve) => {
        resolveRun = resolve;
      });
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    const timerPromise = onTimer(state);
    await started;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    // Remove the job from disk while execution is in progress
    await writeCronStoreSnapshot({ storePath, jobs: [] });
    resolveRun?.({ status: "ok", summary: "done" });
    await timerPromise;

    // applyOutcomeToStoredJob handles the missing job gracefully:
    // it force-reloads, finds the job is gone, logs a warning, and discards.
    expect(state.store?.jobs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "removed-post-exec" }),
      "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded",
    );
  });
});
