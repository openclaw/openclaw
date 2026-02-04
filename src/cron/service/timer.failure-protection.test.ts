import { describe, it, expect, beforeEach } from "vitest";
import type { CronJob, CronJobState } from "../types.js";
import type { CronServiceState } from "./state.js";
import { executeJob } from "./timer.js";

describe("CronService - Failure Protection for Isolated Tasks", () => {
  let mockState: Partial<CronServiceState>;
  let testJob: CronJob;
  let nowMs: number;

  beforeEach(() => {
    nowMs = Date.now();
    testJob = {
      id: "test-job-1",
      name: "Test failing job",
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "This will fail",
      },
      state: {
        consecutiveFailures: 0,
      } as CronJobState,
    };

    mockState = {
      deps: {
        cronEnabled: true,
        nowMs: () => nowMs,
        onEvent: () => {},
        enqueueSystemEvent: () => {},
        requestHeartbeatNow: () => {},
        log: {
          error: () => {},
          warn: () => {},
          info: () => {},
          debug: () => {},
        },
        runIsolatedAgentJob: async () => ({
          status: "error",
          error: "Process not found",
          summary: "Failed to execute command",
        }),
      },
      store: { jobs: [testJob], version: 1 },
      running: false,
    } as unknown as CronServiceState;
  });

  it("should increment consecutiveFailures on error", async () => {
    expect(testJob.state.consecutiveFailures).toBe(0);

    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });

    expect(testJob.state.consecutiveFailures).toBe(1);
    expect(testJob.state.lastStatus).toBe("error");
    // Task should still be enabled after 1 failure
    expect(testJob.enabled).toBe(true);
  });

  it("should continue retrying up to MAX_CONSECUTIVE_FAILURES (3)", async () => {
    testJob.state.consecutiveFailures = 0;

    // First failure
    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });
    expect(testJob.state.consecutiveFailures).toBe(1);
    expect(testJob.enabled).toBe(true);
    expect(testJob.state.nextRunAtMs).toBeDefined(); // Should have next run time

    // Second failure
    await executeJob(mockState as CronServiceState, testJob, nowMs + 2000, { forced: false });
    expect(testJob.state.consecutiveFailures).toBe(2);
    expect(testJob.enabled).toBe(true);
    expect(testJob.state.nextRunAtMs).toBeDefined();

    // Third failure - should auto-disable
    await executeJob(mockState as CronServiceState, testJob, nowMs + 4000, { forced: false });
    expect(testJob.state.consecutiveFailures).toBe(3);
    expect(testJob.enabled).toBe(false); // Disabled after 3 failures
    expect(testJob.state.nextRunAtMs).toBeUndefined(); // No more scheduled runs
  });

  it("should reset consecutiveFailures counter on success", async () => {
    testJob.state.consecutiveFailures = 2;

    // Mock success
    (
      mockState.deps as unknown as {
        runIsolatedAgentJob: () => Promise<{ status: string; summary: string }>;
      }
    ).runIsolatedAgentJob = async () => ({
      status: "ok",
      summary: "Job completed successfully",
    });

    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });

    expect(testJob.state.consecutiveFailures).toBe(0);
    expect(testJob.enabled).toBe(true);
  });

  it("should implement exponential backoff for isolated tasks on failure", async () => {
    testJob.state.consecutiveFailures = 0;

    // First failure: should schedule retry after 1s (1000 * 2^0)
    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });
    expect(testJob.state.consecutiveFailures).toBe(1);
    const firstBackoff = testJob.state.nextRunAtMs ? testJob.state.nextRunAtMs - nowMs : 0;
    expect(firstBackoff).toBe(1000); // 1 second

    // Second failure: should schedule retry after 2s (1000 * 2^1)
    nowMs += 1000;
    testJob.state.runningAtMs = undefined;
    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });
    expect(testJob.state.consecutiveFailures).toBe(2);
    const secondBackoff = testJob.state.nextRunAtMs ? testJob.state.nextRunAtMs - nowMs : 0;
    expect(secondBackoff).toBe(2000); // 2 seconds
  });

  it("should auto-disable main session tasks after MAX_CONSECUTIVE_FAILURES", async () => {
    testJob.sessionTarget = "main";
    testJob.payload = {
      kind: "systemEvent",
      text: "Test message",
    };
    testJob.state.consecutiveFailures = 0;

    mockState.deps!.enqueueSystemEvent = () => {
      throw new Error("Simulated main session error");
    };

    // Run until 3 failures
    for (let i = 0; i < 4; i++) {
      await executeJob(mockState as CronServiceState, testJob, nowMs + i * 1000, {
        forced: false,
      });
    }

    // Main tasks should also respect MAX_CONSECUTIVE_FAILURES
    expect(testJob.enabled).toBe(false);
  });

  it("should not increment counter on skipped status", async () => {
    // Skipped jobs should not increment failure counter
    (
      mockState.deps as unknown as {
        runIsolatedAgentJob: () => Promise<{ status: string; summary: string }>;
      }
    ).runIsolatedAgentJob = async () => ({
      status: "skipped",
      summary: "Skipped",
    });

    testJob.state.consecutiveFailures = 0;
    await executeJob(mockState as CronServiceState, testJob, nowMs, { forced: false });

    expect(testJob.state.consecutiveFailures).toBe(0); // Counter not incremented on skip
    expect(testJob.enabled).toBe(true); // Still enabled
  });
});
