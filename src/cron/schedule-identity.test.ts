import { describe, expect, it } from "vitest";
import { cronSchedulingInputsEqual, tryCronScheduleIdentity } from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("preserves meaningful whitespace in on-exit command identity", () => {
    const command = " printf %s hello\\ ";
    const makeJob = (text: string) => ({ schedule: { kind: "on-exit", command: text } });
    const job = makeJob(command);
    expect(tryCronScheduleIdentity(job)).toBeDefined();
    expect(cronSchedulingInputsEqual(job, structuredClone(job))).toBe(true);
    for (const changedCommand of [command.trimStart(), command.trimEnd()]) {
      expect(cronSchedulingInputsEqual(job, makeJob(changedCommand))).toBe(false);
    }
    expect(tryCronScheduleIdentity(makeJob(" \t "))).toBeUndefined();
  });

  it("normalizes numeric schedule strings like execution does", () => {
    const numeric = {
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    };
    const stringNumeric = {
      enabled: true,
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    };
    expect(tryCronScheduleIdentity(stringNumeric)).toBe(tryCronScheduleIdentity(numeric));
    expect(cronSchedulingInputsEqual(numeric, stringNumeric)).toBe(true);
  });

  it("normalizes cron stagger identity like execution does", () => {
    const job = (staggerMs?: unknown) => ({
      schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs },
    });
    expect(cronSchedulingInputsEqual(job(42), job(42.8))).toBe(true);
    expect(cronSchedulingInputsEqual(job(0), job(-10))).toBe(true);
    expect(cronSchedulingInputsEqual(job(), job("1e3"))).toBe(true);
  });

  it("normalizes pacing bounds and treats changes as scheduling input changes", () => {
    const job = (min?: string, max?: string) => ({
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
      pacing: min ? { min, max } : undefined,
    });
    expect(cronSchedulingInputsEqual(job("60m", "4h"), job("1h", "240m"))).toBe(true);
    expect(cronSchedulingInputsEqual(job("1h"), job("2h"))).toBe(false);
    expect(cronSchedulingInputsEqual(job("1h"), job())).toBe(false);
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
