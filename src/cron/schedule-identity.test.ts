// Schedule identity tests cover stable identity derivation for cron schedules.
import { describe, expect, it } from "vitest";
import {
  cronSchedulingInputsEqual,
  tryCronRunScheduleIdentity,
  tryCronRunStateIdentity,
  tryCronScheduleIdentity,
} from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("normalizes numeric schedule strings like execution does", () => {
    const numeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    });
    const stringNumeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    });

    expect(stringNumeric).toBe(numeric);
    const stringNumericInput = {
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    } as unknown as Parameters<typeof cronSchedulingInputsEqual>[1];

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 } },
        stringNumericInput,
      ),
    ).toBe(true);
  });

  it("normalizes cron stagger identity like execution does", () => {
    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 42 } },
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 42.8 } },
      ),
    ).toBe(true);

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 0 } },
        { schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: -10 } },
      ),
    ).toBe(true);

    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "cron", expr: "*/5 * * * *" } },
        {
          schedule: {
            kind: "cron",
            expr: "*/5 * * * *",
            staggerMs: "1e3" as unknown as number,
          },
        },
      ),
    ).toBe(true);
  });

  it("normalizes pacing bounds and treats changes as scheduling input changes", () => {
    const schedule = { kind: "every" as const, everyMs: 60_000, anchorMs: 123 };

    expect(
      cronSchedulingInputsEqual(
        { schedule, pacing: { min: "60m", max: "4h" } },
        { schedule, pacing: { min: "1h", max: "240m" } },
      ),
    ).toBe(true);
    expect(
      cronSchedulingInputsEqual(
        { schedule, pacing: { min: "1h" } },
        { schedule, pacing: { min: "2h" } },
      ),
    ).toBe(false);
    expect(cronSchedulingInputsEqual({ schedule, pacing: { min: "1h" } }, { schedule })).toBe(
      false,
    );
  });

  it("tracks trigger presence without depending on trigger script text", () => {
    const schedule = { kind: "cron" as const, expr: "*/5 * * * *" };

    expect(
      cronSchedulingInputsEqual(
        { schedule, trigger: { script: "return true" } },
        { schedule, trigger: { script: "return false" } },
      ),
    ).toBe(true);
    expect(
      cronSchedulingInputsEqual({ schedule }, { schedule, trigger: { script: "return true" } }),
    ).toBe(false);
  });
});

describe("tryCronRunScheduleIdentity", () => {
  it("distinguishes recreated job instances with the same public definition", () => {
    const job = {
      id: "recreated",
      enabled: true,
      schedule: { kind: "at", at: "2026-07-19T09:00:00.000Z" },
      trigger: { script: "return true", once: true },
      payload: { kind: "script", script: "return { state: 1 }" },
      state: { instanceId: "old-instance", scheduleRevision: 2, stateRevision: 3 },
    };
    const replacement = structuredClone(job);
    replacement.state.instanceId = "replacement-instance";

    expect(tryCronRunScheduleIdentity(job)).not.toBe(tryCronRunScheduleIdentity(replacement));
    expect(tryCronRunStateIdentity(job)).not.toBe(tryCronRunStateIdentity(replacement));
  });

  it("identifies on-exit command and working-directory replacements", () => {
    const original = tryCronRunScheduleIdentity({
      enabled: false,
      schedule: { kind: "on-exit", command: "make build", cwd: "/repo" },
    });

    expect(original).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(original).not.toContain("make build");
    expect(original).not.toContain("/repo");
    expect(
      tryCronRunScheduleIdentity({
        enabled: false,
        schedule: { kind: "on-exit", command: "make test", cwd: "/repo" },
      }),
    ).not.toBe(original);
    expect(
      tryCronRunScheduleIdentity({
        enabled: false,
        schedule: { kind: "on-exit", command: "make build", cwd: "/other" },
      }),
    ).not.toBe(original);
  });

  it("distinguishes trigger definitions owned by an active run", () => {
    const schedule = { kind: "cron" as const, expr: "*/5 * * * *" };

    expect(
      tryCronRunScheduleIdentity({ schedule, trigger: { script: "return true", once: true } }),
    ).not.toBe(
      tryCronRunScheduleIdentity({ schedule, trigger: { script: "return false", once: true } }),
    );
    expect(
      tryCronRunScheduleIdentity({ schedule, trigger: { script: "return true", once: true } }),
    ).not.toBe(
      tryCronRunScheduleIdentity({ schedule, trigger: { script: "return true", once: false } }),
    );
  });

  it("distinguishes ABA edits that restore the same schedule values", () => {
    const job = {
      enabled: true,
      schedule: { kind: "at", at: "2026-07-19T09:00:00.000Z" },
    };

    expect(tryCronRunScheduleIdentity({ ...job, state: { scheduleRevision: 0 } })).not.toBe(
      tryCronRunScheduleIdentity({ ...job, state: { scheduleRevision: 2 } }),
    );
  });
});

describe("tryCronRunStateIdentity", () => {
  it("tracks state-writer definitions independently from cadence", () => {
    const original = tryCronRunStateIdentity({
      schedule: { kind: "every", everyMs: 60_000 },
      trigger: { script: "return true", once: true },
      payload: { kind: "script", script: "return { state: 1 }" },
    });

    expect(original).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(original).not.toContain("return true");
    expect(
      tryCronRunStateIdentity({
        schedule: { kind: "every", everyMs: 120_000 },
        trigger: { script: "return true", once: true },
        payload: { kind: "script", script: "return { state: 1 }" },
      }),
    ).toBe(original);
    expect(
      tryCronRunStateIdentity({
        trigger: { script: "return false", once: true },
        payload: { kind: "script", script: "return { state: 1 }" },
      }),
    ).not.toBe(original);
    expect(
      tryCronRunStateIdentity({
        trigger: { script: "return true", once: true },
        payload: { kind: "script", script: "return { state: 2 }" },
      }),
    ).not.toBe(original);
    expect(
      tryCronRunStateIdentity({
        state: { stateRevision: 2 },
        trigger: { script: "return true", once: true },
        payload: { kind: "script", script: "return { state: 1 }" },
      }),
    ).not.toBe(original);
  });
});
