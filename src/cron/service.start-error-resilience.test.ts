import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { start } from "./service/ops.js";
import { clearZombieRunningMarkers } from "./service/timer.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-start-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService start() error resilience", () => {
  it("arms timer and repairs partial state when runMissedJobs throws", async () => {
    const { storePath, cleanup } = await makeStorePath();

    // Write a store with one overdue isolated agentTurn job
    const overdueAtMs = Date.now() - 120_000;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "test-job-1",
              name: "overdue-job",
              enabled: true,
              createdAtMs: overdueAtMs - 60_000,
              updatedAtMs: overdueAtMs - 60_000,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: overdueAtMs - 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "tick", timeoutSeconds: 60 },
              state: { nextRunAtMs: overdueAtMs },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: enqueueSystemEvent as never,
      requestHeartbeatNow: requestHeartbeatNow as never,
      runIsolatedAgentJob: runIsolatedAgentJob as never,
    });

    // Make the second cron-store write fail (applyStartupCatchupOutcomes persist)
    // while allowing the first write (planStartupCatchup persist) to succeed.
    // The job has no initial runningAtMs, so the startup stale-marker cleanup
    // does not persist, meaning writes are:
    //   1. planStartupCatchup persist (runningAtMs set on candidate)
    //   2. applyStartupCatchupOutcomes persist (should fail -> triggers catch)
    let writeCount = 0;
    const origWriteFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...rest) => {
      writeCount++;
      if (writeCount === 2 && typeof file === "string" && file.includes("cron")) {
        throw new Error("simulated disk failure during persist");
      }
      return origWriteFile(file as any, data as any, ...(rest as any[]));
    });

    try {
      // start() should NOT throw even though runMissedJobs will fail
      await start(state);

      // The critical assertion: the timer MUST be armed despite the error
      expect(state.timer).not.toBeNull();
      // The store should still be loaded
      expect(state.store).not.toBeNull();
      expect(state.store!.jobs.length).toBe(1);
      // The catch block must have repaired partial state: any runningAtMs
      // set by planStartupCatchup should be cleared so the job can run on
      // the next tick instead of being stuck until zombie detection fires.
      expect(state.store!.jobs[0].state.runningAtMs).toBeUndefined();
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("repairs one-shot and recurring job state when runMissedJobs throws", async () => {
    const { storePath, cleanup } = await makeStorePath();

    const overdueAtMs = Date.now() - 120_000;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            // One-shot job with stale runningAtMs (gets added to interruptedOneShotIds)
            {
              id: "one-shot-1",
              name: "one-shot-job",
              enabled: true,
              createdAtMs: overdueAtMs - 60_000,
              updatedAtMs: overdueAtMs - 60_000,
              schedule: { kind: "at", at: new Date(overdueAtMs).toISOString() },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "one-shot" },
              state: { nextRunAtMs: overdueAtMs, runningAtMs: overdueAtMs },
            },
            // Recurring job that is overdue (gets picked up as catch-up candidate)
            {
              id: "recurring-1",
              name: "recurring-job",
              enabled: true,
              createdAtMs: overdueAtMs - 60_000,
              updatedAtMs: overdueAtMs - 60_000,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: overdueAtMs - 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "tick", timeoutSeconds: 60 },
              state: { nextRunAtMs: overdueAtMs },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });

    // Fail the third cron-related write (applyStartupCatchupOutcomes persist)
    // while allowing: 1=startup cleanup, 2=planStartupCatchup, 3+=repair
    let writeCount = 0;
    const origWriteFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...rest) => {
      writeCount++;
      // Fail exactly on write 3 (applyStartupCatchupOutcomes persist)
      if (writeCount === 3 && typeof file === "string" && file.includes("cron")) {
        throw new Error("simulated failure during applyStartupCatchupOutcomes");
      }
      return origWriteFile(file as any, data as any, ...(rest as any[]));
    });

    try {
      await start(state);

      // Timer must be armed despite the error
      expect(state.timer).not.toBeNull();
      // The error must have been logged (proves catch block ran)
      expect(noopLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("simulated failure") }),
        expect.stringContaining("startup catch-up failed"),
      );
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("arms timer even when repair persist also fails", async () => {
    const { storePath, cleanup } = await makeStorePath();

    const overdueAtMs = Date.now() - 120_000;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "recurring-1",
              name: "recurring-job",
              enabled: true,
              createdAtMs: overdueAtMs - 60_000,
              updatedAtMs: overdueAtMs - 60_000,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: overdueAtMs - 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "tick", timeoutSeconds: 60 },
              state: { nextRunAtMs: overdueAtMs },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });

    // Fail ALL cron-related writes after the first one.
    // Write 1 (planStartupCatchup) succeeds.
    // Write 2 (applyStartupCatchupOutcomes) fails -> runMissedJobs throws.
    // Write 3 (repair persist in catch block) also fails.
    // The timer must STILL be armed.
    let writeCount = 0;
    const origWriteFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...rest) => {
      writeCount++;
      if (writeCount > 1 && typeof file === "string" && file.includes("cron")) {
        throw new Error("simulated total disk failure");
      }
      return origWriteFile(file as any, data as any, ...(rest as any[]));
    });

    try {
      // start() should NOT throw even though both runMissedJobs AND the
      // repair persist fail
      await start(state);

      // The critical assertion: timer MUST be armed
      expect(state.timer).not.toBeNull();
      // Both error paths should have been logged
      expect(noopLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("total disk failure") }),
        expect.stringContaining("startup catch-up failed"),
      );
      expect(noopLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("total disk failure") }),
        expect.stringContaining("failed to repair catch-up state"),
      );
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("clears stale runningAtMs markers on startup", async () => {
    const { storePath, cleanup } = await makeStorePath();

    const staleRunningAtMs = Date.now() - 3_600_000; // 1 hour ago
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "stale-job",
              name: "stale-running-job",
              enabled: true,
              createdAtMs: staleRunningAtMs - 60_000,
              updatedAtMs: staleRunningAtMs,
              schedule: { kind: "cron", expr: "*/5 * * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "tick" },
              state: {
                nextRunAtMs: Date.now() - 300_000,
                runningAtMs: staleRunningAtMs,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });

    try {
      await start(state);

      // The stale runningAtMs should be cleared
      expect(state.store!.jobs[0].state.runningAtMs).toBeUndefined();
      // Timer should be armed
      expect(state.timer).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("clearZombieRunningMarkers", () => {
  function makeJob(overrides: Partial<CronJob> & { timeoutSeconds?: number } = {}): CronJob {
    const timeoutSeconds = overrides.timeoutSeconds ?? 60;
    return {
      id: "test-job",
      name: "test-job",
      enabled: true,
      createdAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() - 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick", timeoutSeconds },
      state: {
        nextRunAtMs: Date.now() - 10_000,
        runningAtMs: undefined,
      },
      ...overrides,
    } as CronJob;
  }

  it("clears runningAtMs for jobs that exceeded their timeout", () => {
    const now = Date.now();
    const job = makeJob({ timeoutSeconds: 60 }); // 60s timeout -> zombie threshold = 120s
    job.state.runningAtMs = now - 300_000; // 5 min ago, way past 120s threshold

    const state = createCronServiceState({
      storePath: "/tmp/fake",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
    state.store = { version: 1, jobs: [job] };

    const result = clearZombieRunningMarkers(state);

    expect(result).toBe(true);
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("does NOT clear runningAtMs for jobs still within their timeout", () => {
    const now = Date.now();
    const job = makeJob({ timeoutSeconds: 600 }); // 10 min timeout -> zombie threshold = 20 min
    job.state.runningAtMs = now - 300_000; // 5 min ago, within 20 min threshold

    const state = createCronServiceState({
      storePath: "/tmp/fake",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
    state.store = { version: 1, jobs: [job] };

    const result = clearZombieRunningMarkers(state);

    expect(result).toBe(false);
    expect(job.state.runningAtMs).toBe(now - 300_000);
  });

  it("does NOT clear runningAtMs for unlimited-timeout jobs (timeoutSeconds <= 0)", () => {
    const now = Date.now();
    const job = makeJob({ timeoutSeconds: 0 }); // unlimited
    job.state.runningAtMs = now - 7_200_000; // 2 hours ago

    const state = createCronServiceState({
      storePath: "/tmp/fake",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
    state.store = { version: 1, jobs: [job] };

    const result = clearZombieRunningMarkers(state);

    expect(result).toBe(false);
    expect(job.state.runningAtMs).toBe(now - 7_200_000);
  });

  it("skips jobs without a runningAtMs marker", () => {
    const job = makeJob({ timeoutSeconds: 60 });
    // runningAtMs is undefined by default

    const state = createCronServiceState({
      storePath: "/tmp/fake",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
    state.store = { version: 1, jobs: [job] };

    const result = clearZombieRunningMarkers(state);

    expect(result).toBe(false);
  });
});
