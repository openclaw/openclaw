import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { start } from "./service/ops.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-start-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService start() error resilience", () => {
  it("arms timer even when runMissedJobs throws", async () => {
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });

    // Write a store with one overdue job so runMissedJobs has work to do
    const overdueAtMs = Date.now() - 120_000;
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
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "tick" },
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
    const runIsolatedAgentJob = vi.fn(async () => {
      throw new Error("simulated catastrophic failure in missed job execution");
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: enqueueSystemEvent as never,
      requestHeartbeatNow: requestHeartbeatNow as never,
      runIsolatedAgentJob: runIsolatedAgentJob as never,
    });

    // start() should NOT throw even though runMissedJobs will fail
    await start(state);

    // The critical assertion: the timer MUST be armed despite the error
    expect(state.timer).not.toBeNull();
    // The store should still be loaded
    expect(state.store).not.toBeNull();
    expect(state.store!.jobs.length).toBe(1);
  });

  it("clears stale runningAtMs markers on startup", async () => {
    const storePath = makeStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });

    const staleRunningAtMs = Date.now() - 3_600_000; // 1 hour ago
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

    await start(state);

    // The stale runningAtMs should be cleared
    expect(state.store!.jobs[0].state.runningAtMs).toBeUndefined();
    // Timer should be armed
    expect(state.timer).not.toBeNull();
  });
});
