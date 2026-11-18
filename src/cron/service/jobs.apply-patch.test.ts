import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { projectCronJobThroughStorageCodec } from "../store/row-codec.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import { applyJobPatch, createJob } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return makeCronJob({
    wakeMode: "now",
    delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
    ...overrides,
  });
}

function makeMainJob(delivery?: CronJob["delivery"]) {
  return makeJob({
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "tick" },
    delivery,
  });
}

describe("applyJobPatch schedule retention", () => {
  it.each([undefined, false] as const)(
    "converts recurring to at with cleanup policy %s",
    (policy) => {
      const job =
        policy === undefined
          ? makeJob({ schedule: { kind: "cron", expr: "0 * * * *" } })
          : makeJob({ deleteAfterRun: true });
      applyJobPatch(job, {
        schedule: { kind: "at", at: "2026-07-19T09:00:00.000Z" },
        ...(policy === undefined ? {} : { deleteAfterRun: policy }),
      });
      expect(job).toMatchObject({ schedule: { kind: "at" }, deleteAfterRun: policy ?? true });
    },
  );

  it.each([
    { kind: "at", at: "2026-07-19T09:00:00.000Z" },
    { kind: "on-exit", command: "true" },
  ] as const)(
    "clears inherited $kind cleanup on recurring conversion but honors explicit policies",
    (previous) => {
      for (const deleteAfterRun of [undefined, false, true]) {
        const job = makeJob({ schedule: previous, deleteAfterRun: true });

        applyJobPatch(job, {
          schedule: { kind: "cron", expr: "0 * * * *" },
          ...(deleteAfterRun === undefined ? {} : { deleteAfterRun }),
        });

        expect(job.schedule.kind).toBe("cron");
        expect(job.deleteAfterRun).toBe(deleteAfterRun);
        expect(Object.hasOwn(job, "deleteAfterRun")).toBe(deleteAfterRun !== undefined);
      }
    },
  );
});

describe("schedule activation ownership", () => {
  it("ignores caller-supplied activation state during creation", () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const input = {
      ...makeMainJob(),
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      state: {
        scheduleActivatedAtMs: now - 60_000,
        runningScheduleChangeId: "caller-supplied-edit",
      },
    } as unknown as CronJobCreate;

    const job = createJob({ deps: { nowMs: () => now, defaultAgentId: "main" } }, input);

    expect([job.state.scheduleActivatedAtMs, job.state.runningScheduleChangeId]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("ignores caller-supplied activation state during updates", () => {
    const job = makeJob({
      state: { scheduleActivatedAtMs: 456, runningScheduleChangeId: "pending-run-edit" },
    });
    applyJobPatch(job, {
      state: { scheduleActivatedAtMs: 123, runningScheduleChangeId: null },
    } as unknown as CronJobPatch);
    expect(job.state).toMatchObject({
      scheduleActivatedAtMs: 456,
      runningScheduleChangeId: "pending-run-edit",
    });
  });

  it("rejects out-of-Date-range caller state for startupCatchupAtMs", () => {
    const job = makeJob({ enabled: false });
    const patch = { state: { startupCatchupAtMs: MAX_DATE_TIMESTAMP_MS + 1 } };
    expect(() => applyJobPatch(job, patch)).toThrow("cron state.startupCatchupAtMs");
    expect(job.state.startupCatchupAtMs).toBeUndefined();
  });
});

describe("applyJobPatch delivery merge", () => {
  it.each([
    {
      channel: null,
      to: null,
      threadId: null,
      accountId: null,
      completionDestination: null,
    },
    { mode: "none", channel: "telegram", to: "123", threadId: 0, accountId: "bot-a" },
  ] satisfies NonNullable<CronJobPatch["delivery"]>[])(
    "preserves main-session no-delivery semantics for %j",
    (delivery) => {
      const job = makeMainJob();

      applyJobPatch(job, { delivery });

      expect(job.delivery).toBeUndefined();
      expect(resolveCronDeliveryPlan(job).mode).toBe("none");
    },
  );

  it.each([
    { mode: "announce" },
    { completionDestination: { mode: "webhook", to: "https://example.com/completed" } },
  ] satisfies NonNullable<CronJobPatch["delivery"]>[])(
    "rejects authored main delivery %j",
    (delivery) => {
      const job = makeMainJob();

      expect(() => applyJobPatch(job, { delivery })).toThrow(
        'cron channel delivery config is only supported for sessionTarget="isolated"',
      );
    },
  );

  it("persists Off, On and clearing to the gateway default", () => {
    const job = makeJob({ failureAlert: true });
    applyJobPatch(job, { failureAlert: false });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toBe(false);
    applyJobPatch(job, { failureAlert: true });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toBe(true);
    applyJobPatch(job, { failureAlert: null });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toBeUndefined();
  });

  it("preserves inherited main-session webhook mode in a partial delivery update", () => {
    const job = makeMainJob({ mode: "webhook", to: "https://example.com/old" });

    applyJobPatch(job, {
      delivery: { to: "https://example.com/new" },
    });

    expect(job.delivery).toEqual({
      mode: "webhook",
      to: "https://example.com/new",
    });
  });
});
