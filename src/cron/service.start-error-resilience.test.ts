import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { start } from "./service/ops.js";
import { onTimer } from "./service/timer.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-start-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService start() error resilience", () => {
  it("arms timer even when runMissedJobs throws", async () => {
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

    // Make persist fail after the first write (in planStartupCatchup) so
    // that applyStartupCatchupOutcomes throws, propagating through
    // runMissedJobs and triggering the try/catch guard in start().
    let writeCount = 0;
    const origWriteFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...rest) => {
      writeCount++;
      if (writeCount > 1 && typeof file === "string" && file.includes("cron")) {
        throw new Error("simulated disk failure during persist");
      }
      // @ts-expect-error overload resolution
      return origWriteFile(file, data, ...rest);
    });

    try {
      // start() should NOT throw even though runMissedJobs will fail
      await start(state);

      // The critical assertion: the timer MUST be armed despite the error
      expect(state.timer).not.toBeNull();
      // The store should still be loaded
      expect(state.store).not.toBeNull();
      expect(state.store!.jobs.length).toBe(1);
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

describe("CronService onTimer() zombie detection", () => {
  it("clears zombie runningAtMs markers for jobs that exceeded their timeout", async () => {
    const { storePath, cleanup } = await makeStorePath();

    // A job that has been "running" for 2 hours with a 60s timeout
    const zombieRunningAtMs = Date.now() - 7_200_000; // 2 hours ago
    const overdueNextRunAtMs = Date.now() - 300_000; // 5 min overdue

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "zombie-job",
              name: "zombie-job",
              enabled: true,
              createdAtMs: overdueNextRunAtMs - 60_000,
              updatedAtMs: overdueNextRunAtMs,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: overdueNextRunAtMs - 60_000 },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "tick", timeoutSeconds: 60 },
              state: {
                nextRunAtMs: overdueNextRunAtMs,
                runningAtMs: zombieRunningAtMs,
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
      enqueueSystemEvent: vi.fn().mockResolvedValue(undefined) as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });

    try {
      // Load the store first (start would clear markers, so we simulate
      // the state where a job is stuck as running after the scheduler has
      // already started)
      await start(state);

      // Now simulate a zombie: set runningAtMs to a past value
      state.store!.jobs[0].state.runningAtMs = zombieRunningAtMs;
      state.running = false; // reset running flag so onTimer proceeds

      // Set a due nextRunAtMs so the job would be picked up
      state.store!.jobs[0].state.nextRunAtMs = Date.now() - 1000;

      await onTimer(state);

      // The zombie marker should have been cleared and the job executed
      expect(state.store!.jobs[0].state.runningAtMs).not.toBe(zombieRunningAtMs);
    } finally {
      await cleanup();
    }
  });

  it("does NOT clear runningAtMs for unlimited-timeout jobs", async () => {
    const { storePath, cleanup } = await makeStorePath();

    // A job with timeoutSeconds: 0 (unlimited) that has been running for 2 hours
    const longRunningMs = Date.now() - 7_200_000;

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "unlimited-job",
              name: "unlimited-timeout-job",
              enabled: true,
              createdAtMs: longRunningMs - 60_000,
              updatedAtMs: longRunningMs,
              schedule: { kind: "cron", expr: "0 * * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "tick", timeoutSeconds: 0 },
              state: {
                nextRunAtMs: Date.now() + 60_000,
                runningAtMs: longRunningMs,
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
      enqueueSystemEvent: vi.fn().mockResolvedValue(undefined) as never,
      requestHeartbeatNow: vi.fn() as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });

    try {
      await start(state);

      // Set up for onTimer tick
      state.store!.jobs[0].state.runningAtMs = longRunningMs;
      state.running = false;

      await onTimer(state);

      // The unlimited-timeout job should NOT have its marker cleared
      expect(state.store!.jobs[0].state.runningAtMs).toBe(longRunningMs);
    } finally {
      await cleanup();
    }
  });
});
