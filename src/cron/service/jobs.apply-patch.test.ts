import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
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

const clearFailureDestination = { channel: null, to: null, accountId: null, mode: null };
const clearedFailureDestination = {
  channel: undefined,
  to: undefined,
  accountId: undefined,
  mode: undefined,
};
const failureDefaults = { channel: "slack", to: "C123", accountId: "bot-b" };

describe("applyJobPatch schedule retention", () => {
  it("defaults cron to cleanup when converting it to at", () => {
    const job = makeJob({ schedule: { kind: "cron", expr: "0 * * * *" } });
    applyJobPatch(job, { schedule: { kind: "at", at: "2026-07-19T09:00:00.000Z" } });
    expect(job).toMatchObject({ schedule: { kind: "at" }, deleteAfterRun: true });
  });

  it("preserves an explicit keep policy when converting a recurring job to at", () => {
    const job = makeJob({ deleteAfterRun: true });

    applyJobPatch(job, {
      schedule: { kind: "at", at: "2026-07-19T09:00:00.000Z" },
      deleteAfterRun: false,
    });

    expect(job.deleteAfterRun).toBe(false);
  });

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
      name: "owned activation",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        scheduleActivatedAtMs: now - 60_000,
        runningScheduleChangeId: "caller-supplied-edit",
      },
    } as unknown as CronJobCreate;

    const job = createJob({ deps: { nowMs: () => now, defaultAgentId: "main" } }, input);

    expect(job.state.scheduleActivatedAtMs).toBeUndefined();
    expect(job.state.runningScheduleChangeId).toBeUndefined();
  });

  it("ignores caller-supplied activation state during updates", () => {
    const job = makeJob({
      state: { scheduleActivatedAtMs: 456, runningScheduleChangeId: "pending-run-edit" },
    });
    const patch = {
      state: { scheduleActivatedAtMs: 123, runningScheduleChangeId: null },
    } as unknown as CronJobPatch;

    applyJobPatch(job, patch);

    expect(job.state.scheduleActivatedAtMs).toBe(456);
    expect(job.state.runningScheduleChangeId).toBe("pending-run-edit");
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
      name: "nullable clears",
      delivery: {
        channel: null,
        to: null,
        threadId: null,
        accountId: null,
        completionDestination: null,
        failureDestination: null,
      },
    },
    {
      name: "explicitly disabled routes",
      delivery: { mode: "none", channel: "telegram", to: "123", threadId: 0, accountId: "bot-a" },
    },
  ] satisfies Array<{ name: string; delivery: NonNullable<CronJobPatch["delivery"]> }>)(
    "preserves main-session no-delivery semantics for $name",
    ({ delivery }) => {
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

  it("clears inherited announce delivery when retargeting to main with bestEffort", () => {
    const job = makeJob();
    applyJobPatch(job, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
      delivery: { bestEffort: false },
    });
    expect(job).toMatchObject({ sessionTarget: "main", delivery: undefined });
  });

  it("preserves inherited main-session webhook mode in a partial delivery update", () => {
    const job = makeMainJob({ mode: "webhook", to: "https://example.com/old", bestEffort: true });

    applyJobPatch(job, {
      delivery: { to: "https://example.com/new", bestEffort: false },
    });

    expect(job.delivery).toEqual({
      mode: "webhook",
      to: "https://example.com/new",
      bestEffort: false,
    });
  });

  it.each(["isolated", "main"] as const)(
    "clears %s failure routes as global opt-outs",
    (target) => {
      const job =
        target === "main"
          ? makeMainJob()
          : makeJob({
              delivery: {
                mode: "announce",
                channel: "telegram",
                to: "-1001234567890",
                failureDestination: { mode: "announce", ...failureDefaults },
              },
            });
      applyJobPatch(job, { delivery: { failureDestination: clearFailureDestination } });

      const failureDestination = job.delivery?.failureDestination;
      expect(failureDestination).toStrictEqual(clearedFailureDestination);
      if (target === "main") {
        expect(job.delivery?.mode).toBe("none");
      }
      const accountId = target === "main" ? "bot-a" : "bot-b";
      expect(resolveFailureDestination(job, { ...failureDefaults, accountId })).toBeNull();
    },
  );

  it("keeps unspecified failure destination fields inheriting global defaults", () => {
    const job = makeJob();

    applyJobPatch(job, { delivery: { failureDestination: { to: "C123" } } });

    const failureDestination = job.delivery?.failureDestination;
    expect(failureDestination).toEqual({ to: "C123" });
    expect(Object.hasOwn(failureDestination as object, "channel")).toBe(false);
    expect(resolveFailureDestination(job, { channel: "slack", accountId: "bot-a" })).toEqual({
      mode: "announce",
      channel: "slack",
      to: "C123",
      accountId: "bot-a",
    });
  });
});

describe("applyJobPatch failure alert merge", () => {
  it("clears explicit fields, preserves omitted fields, and persists the result", () => {
    const kept = { channel: "telegram", includeSkipped: true, mode: "announce" as const };
    const job = makeJob({
      failureAlert: {
        ...kept,
        after: 2,
        to: "123456",
        cooldownMs: 60_000,
        accountId: "bot-a",
      },
    });

    applyJobPatch(job, {
      failureAlert: { after: null, to: null, cooldownMs: null, accountId: null },
    });

    expect(job.failureAlert).toEqual({
      ...kept,
      after: undefined,
      to: undefined,
      cooldownMs: undefined,
      accountId: undefined,
    });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toEqual(kept);

    applyJobPatch(job, {
      failureAlert: { channel: null, includeSkipped: null, mode: null },
    });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toEqual({});
  });

  it("clears the whole override only for explicit null", () => {
    const original = { after: 2, channel: "telegram" as const };
    const job = makeJob({ failureAlert: original });

    applyJobPatch(job, {});
    expect(job.failureAlert).toEqual(original);

    applyJobPatch(job, { failureAlert: null });
    expect(job.failureAlert).toBeUndefined();
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toBeUndefined();
  });
});
