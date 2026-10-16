// Schedule identity tests cover stable identity derivation for cron schedules.
import { describe, expect, it } from "vitest";
import { cronSchedulingInputsEqual, tryCronScheduleIdentity } from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("preserves meaningful whitespace in on-exit command identity", () => {
    const command = " printf %s hello\\ ";
    const job = { schedule: { kind: "on-exit", command } };
    expect(tryCronScheduleIdentity(job)).toBeDefined();
    expect(cronSchedulingInputsEqual(job, structuredClone(job))).toBe(true);
    for (const changedCommand of [command.trimStart(), command.trimEnd()]) {
      expect(
        cronSchedulingInputsEqual(job, {
          schedule: { kind: "on-exit", command: changedCommand },
        }),
      ).toBe(false);
    }
    expect(
      tryCronScheduleIdentity({ schedule: { kind: "on-exit", command: " \t " } }),
    ).toBeUndefined();
  });

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
