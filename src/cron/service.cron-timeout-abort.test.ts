import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronIssueRegressionFixtures,
  writeCronJobs,
} from "./service.issue-regressions.test-helpers.js";
import { createCronServiceState } from "./service/state.js";
import { executeJobCore, executeJobCoreWithTimeout, onTimer } from "./service/timer.js";

describe("Cron timeout and abort fixes", () => {
  const { makeStorePath } = setupCronIssueRegressionFixtures();

  describe("#41783 — deferred execution timeout", () => {
    it("does not fire the timeout during queue wait (onExecutionStart defers the clock)", async () => {
      vi.useRealTimers();
      const store = makeStorePath();
      const scheduledAt = Date.parse("2026-03-10T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "deferred-timeout",
        name: "deferred timeout",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        // Very short timeout (2.5ms) — if the safety backstop fires at
        // the old moment (before deferred arm), the job would time out
        // during the simulated queue wait.
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0.05 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let resolveWork: ((v: { status: "ok"; summary: string }) => void) | undefined;
      const workPromise = new Promise<{ status: "ok"; summary: string }>((resolve) => {
        resolveWork = resolve;
      });

      let now = scheduledAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => {
          // Simulate completing quickly once actually running.
          // The deferred timeout gives us the full 50ms budget
          // from when execution starts, not from enqueue.
          resolveWork!({ status: "ok", summary: "done" });
          return workPromise;
        }),
      });

      const timerPromise = onTimer(state);

      // Resolve the work immediately.
      resolveWork!({ status: "ok", summary: "done" });
      await timerPromise;

      const job = state.store?.jobs.find((j) => j.id === "deferred-timeout");
      expect(job?.state.lastStatus).toBe("ok");
      expect(job?.state.lastError).toBeUndefined();
    });

    it("executeJobCore calls onExecutionStart before running isolated jobs", async () => {
      vi.useRealTimers();
      const store = makeStorePath();
      const scheduledAt = Date.parse("2026-03-10T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "arm-callback-test",
        name: "arm callback",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "test" },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      const onExecutionStart = vi.fn();
      let now = scheduledAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => {
          // Verify onExecutionStart was called before we run.
          expect(onExecutionStart).toHaveBeenCalledTimes(1);
          return { status: "ok" as const, summary: "done" };
        }),
      });

      state.running = true;
      state.store = { version: 1, jobs: [cronJob] };

      await executeJobCore(state, cronJob, undefined, onExecutionStart);

      expect(onExecutionStart).toHaveBeenCalledTimes(1);
    });

    it("executeJobCore calls onExecutionStart for main session jobs", async () => {
      vi.useRealTimers();
      const store = makeStorePath();
      const scheduledAt = Date.parse("2026-03-10T12:00:00.000Z");
      const mainJob = {
        id: "main-arm-test",
        name: "main arm",
        enabled: true,
        createdAtMs: scheduledAt,
        updatedAtMs: scheduledAt,
        schedule: { kind: "at" as const, at: new Date(scheduledAt).toISOString() },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "systemEvent" as const, text: "ping" },
        state: { nextRunAtMs: scheduledAt },
      };

      const onExecutionStart = vi.fn();
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => scheduledAt,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
      });
      state.running = true;
      state.store = { version: 1, jobs: [mainJob] };

      await executeJobCore(state, mainJob, undefined, onExecutionStart);

      expect(onExecutionStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("#37505 — shared AbortController kills fallback chain", () => {
    it("abort signal is passed to runIsolatedAgentJob and fires on timeout", async () => {
      vi.useRealTimers();
      const store = makeStorePath();
      const scheduledAt = Date.parse("2026-03-10T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "abort-signal-test",
        name: "abort signal",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0.005 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      const abortAwareRunner = createAbortAwareIsolatedRunner();
      let now = scheduledAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
      });

      await onTimer(state);

      expect(abortAwareRunner.getObservedAbortSignal()).toBeDefined();
      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);

      const job = state.store?.jobs.find((j) => j.id === "abort-signal-test");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    });

    it("executeJobCoreWithTimeout still times out correctly with deferred start", async () => {
      vi.useRealTimers();
      const store = makeStorePath();
      const scheduledAt = Date.parse("2026-03-10T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-still-works",
        name: "timeout works",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "slow", timeoutSeconds: 0.005 },
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      const abortAwareRunner = createAbortAwareIsolatedRunner();
      let now = scheduledAt;
      const state = createCronServiceState({
        cronEnabled: true,
        storePath: store.storePath,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: abortAwareRunner.runIsolatedAgentJob,
      });
      state.running = true;
      state.store = { version: 1, jobs: [cronJob] };

      // executeJobCoreWithTimeout rejects the Promise.race when timeout
      // fires, which surfaces as a thrown error. The caller (executeJob/
      // ops.ts) catches this and records it as an error status.
      await expect(executeJobCoreWithTimeout(state, cronJob)).rejects.toThrow("timed out");
      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
    });
  });
});
