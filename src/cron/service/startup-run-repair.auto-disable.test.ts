import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { makeCronRecoveryState } from "./run-recovery.test-support.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import type { DeferredCronNotifications } from "./state.js";

const runAt = "2026-08-01T16:00:00.000Z";
const runningAtMs = Date.parse(runAt);
type Repair = Parameters<typeof restoreFinalizedStartupRun>[0];

function repairFixture(overrides: Partial<CronJob> = {}) {
  const state = makeCronRecoveryState(
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    "/tmp/startup-run-repair.json",
    runningAtMs + 1_000,
  );
  const job = makeCronJob({
    schedule: { kind: "every", everyMs: 60_000, anchorMs: runningAtMs - 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "do not replay" },
    state: { nextRunAtMs: runningAtMs, runningAtMs },
    ...overrides,
  });
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
    restore: (entry: Partial<Repair["entry"]>, extra: Partial<Repair> = {}) =>
      restoreFinalizedStartupRun({ ...params, ...extra, entry: { ...params.entry, ...entry } }),
  };
}

it("disables a job instead of restoring an invalid finalized next run", () => {
  const { state, job, deferredNotifications, restore } = repairFixture();
  restore({ nextRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 });

  expect(job.enabled).toBe(false);
  expect(job.state.nextRunAtMs).toBeUndefined();
  expect(job.state.autoDisabled).toEqual({
    reason: "schedule-errors",
    atMs: runningAtMs + 1_000,
    consecutiveErrors: 1,
  });
  expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
  expect(deferredNotifications).toHaveLength(1);
});

it.each([
  ["failed", "not-delivered", "announce", { status: "delivered", delivered: true }],
  ["succeeded", "unknown", "none", undefined],
] as const)(
  "uses recorded %s completion for one-shot cleanup",
  (completionStatus, deliveryStatus, mode, failureNotificationDelivery) => {
    const { state, job, deferredNotifications, restore } = repairFixture({
      deleteAfterRun: true,
      schedule: { kind: "at", at: runAt },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do not replay" },
      // Current policy is intentionally mutable and must not decide replay.
      delivery: { mode, bestEffort: true },
      failureAlert: { mode: "webhook", to: "https://alerts.example.test/cron" },
      state: { runningAtMs },
    });
    state.deps.sendCronFailureAlert = vi.fn(async () => undefined);
    const restored = restore({ completionStatus, deliveryStatus, failureNotificationDelivery });

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
  },
);

it("buffers quiet-trigger repair notifications until the recovery commit", () => {
  const { state, job, deferredNotifications, restore } = repairFixture({
    schedule: { kind: "cron", expr: "invalid" },
    trigger: { script: "return false" },
    state: {
      nextRunAtMs: runningAtMs,
      runningAtMs,
      scheduleErrorCount: 2,
    },
  });
  restore(
    { durationMs: undefined },
    {
      triggerEval: { fired: false, stateChanged: false, busy: true },
    },
  );

  expect(job.state.autoDisabled?.reason).toBe("schedule-errors");
  expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
  expect(deferredNotifications).toHaveLength(1);
});

it("ignores finalized startup history with an invalid timestamp", () => {
  const { job, restore } = repairFixture();
  const before = structuredClone(job);

  const result = restore({ ts: MAX_DATE_TIMESTAMP_MS + 1 });

  expect(result).toBeUndefined();
  expect(job).toEqual(before);
});
