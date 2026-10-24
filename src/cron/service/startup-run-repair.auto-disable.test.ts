import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import * as cronSchedule from "../schedule.js";
import type { CronJob } from "../types.js";
import { makeCronRecoveryState } from "./run-recovery.test-support.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import type { DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

const runAt = "2026-08-01T16:00:00.000Z";
const runningAtMs = Date.parse(runAt);

function repairFixture(overrides: Partial<CronJob> = {}) {
  const state = makeCronRecoveryState(
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    "/tmp/startup-run-repair.json",
    runningAtMs + 1_000,
  );
  state.deps.runIsolatedAgentJob = vi.fn();
  const job: CronJob = {
    id: "startup-repair",
    name: "startup-repair",
    enabled: true,
    createdAtMs: runningAtMs - 60_000,
    updatedAtMs: runningAtMs,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: runningAtMs - 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "do not replay" },
    state: { nextRunAtMs: runningAtMs, runningAtMs },
    ...overrides,
  };
  const deferredNotifications: DeferredCronNotifications = [];
  const params = {
    state,
    job,
    runningAtMs,
    deferredNotifications,
    entry: {
      ts: runningAtMs + 1_000,
      jobId: job.id,
      action: "finished" as const,
      status: "ok" as const,
      runAtMs: runningAtMs,
      durationMs: 1_000,
    },
  };
  return {
    ...params,
    restore: (patch: Partial<Parameters<typeof restoreFinalizedStartupRun>[0]> = {}) =>
      restoreFinalizedStartupRun({ ...params, ...patch }),
  };
}

describe("startup run repair auto-disable", () => {
  it("disables a job instead of restoring an invalid finalized next run", async () => {
    const { state, job, deferredNotifications, entry, restore } = repairFixture();
    restore({ entry: { ...entry, nextRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 } });

    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.autoDisabled).toEqual({
      reason: "schedule-errors",
      atMs: runningAtMs + 1_000,
      consecutiveErrors: 1,
    });
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);

    await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    expect(state.deps.enqueueSessionEvent).toHaveBeenCalledOnce();
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "required delivery failed",
      completionStatus: "failed" as const,
      deliveryStatus: "not-delivered" as const,
      failureNotificationDelivery: { status: "delivered" as const, delivered: true },
    },
    {
      name: "best-effort unknown completion followed by a delivery mode edit",
      completionStatus: "succeeded" as const,
      deliveryStatus: "unknown" as const,
      deliveryMode: "none" as const,
    },
  ])("applies recorded completion to one-shot cleanup after $name", (testCase) => {
    const { completionStatus, deliveryStatus } = testCase;
    const failureNotificationDelivery =
      "failureNotificationDelivery" in testCase ? testCase.failureNotificationDelivery : undefined;
    const { state, job, deferredNotifications, entry, restore } = repairFixture({
      deleteAfterRun: true,
      schedule: { kind: "at", at: runAt },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do not replay" },
      // Current policy is intentionally mutable and must not decide replay.
      delivery: {
        mode: testCase.deliveryMode ?? "announce",
        bestEffort: true,
      },
      failureAlert: { mode: "webhook", to: "https://alerts.example.test/cron" },
      state: { runningAtMs },
    });
    state.deps.sendCronFailureAlert = vi.fn(async () => undefined);
    const restored = restore({
      entry: {
        ...entry,
        completionStatus,
        deliveryStatus,
        failureNotificationDelivery,
      },
    });

    expect(restored?.shouldDelete).toBe(completionStatus === "succeeded");
    expect(job.state).toMatchObject({ lastRunStatus: "ok", consecutiveErrors: 0 });
    if (!restored?.shouldDelete) {
      expect(job.enabled).toBe(false);
    }
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(deferredNotifications).toEqual([]);
    expect(state.deps.sendCronFailureAlert).not.toHaveBeenCalled();
    if (failureNotificationDelivery) {
      expect(job.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
      expect(job.state.lastFailureNotificationDelivered).toBe(true);
    }
  });

  it("buffers quiet-trigger repair notifications until the recovery commit", () => {
    const { state, job, deferredNotifications, entry, restore } = repairFixture({
      schedule: { kind: "cron", expr: "0 * * * *", tz: "Invalid/Zone" },
      trigger: { script: "return false" },
      state: {
        nextRunAtMs: runningAtMs,
        runningAtMs,
        scheduleErrorCount: 2,
      },
    });
    const computeSpy = vi.spyOn(cronSchedule, "computeNextRunAtMs").mockImplementation(() => {
      throw new Error("simulated quiet-trigger schedule failure");
    });

    try {
      restore({
        triggerEval: { fired: false, stateChanged: false, busy: true },
        entry: { ...entry, durationMs: undefined },
      });
    } finally {
      computeSpy.mockRestore();
    }

    expect(job.state.autoDisabled?.reason).toBe("schedule-errors");
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);
  });

  it("ignores finalized startup history with an invalid timestamp", () => {
    const { state, job, entry, restore } = repairFixture({
      schedule: { kind: "every", everyMs: 60_000 },
    });
    const before = structuredClone(job);

    const result = restore({ entry: { ...entry, ts: MAX_DATE_TIMESTAMP_MS + 1 } });

    expect(result).toBeUndefined();
    expect(job).toEqual(before);
    expect(state.deps.log.warn).toHaveBeenCalledWith(
      { jobId: job.id },
      "cron: ignoring finalized startup run with an invalid timestamp envelope",
    );
  });
});
