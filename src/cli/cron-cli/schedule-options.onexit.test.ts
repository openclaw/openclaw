import { describe, expect, it } from "vitest";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";

describe("resolveCronCreateScheduleFromArgs --on-exit", () => {
  it("builds an on-exit schedule from --on-exit (+ optional cwd)", () => {
    expect(resolveCronCreateScheduleFromArgs({ onExit: "make build" })).toEqual({
      kind: "on-exit",
      command: "make build",
    });
    expect(resolveCronCreateScheduleFromArgs({ onExit: "./watch.sh", onExitCwd: "/repo" })).toEqual(
      { kind: "on-exit", command: "./watch.sh", cwd: "/repo" },
    );
  });

  it("rejects --on-exit combined with another schedule", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ onExit: "make", every: "10m" })).toThrow(
      /exactly one schedule/,
    );
  });

  it("rejects --on-exit combined with a positional schedule", () => {
    expect(() =>
      resolveCronCreateScheduleFromArgs({ onExit: "make", positionalSchedule: "10m" }),
    ).toThrow(/positional schedule or one of/);
  });

  it("rejects --tz/--stagger with --on-exit", () => {
    expect(() =>
      resolveCronCreateScheduleFromArgs({ onExit: "make", tz: "Asia/Shanghai" }),
    ).toThrow(/not valid with --on-exit/);
  });
});
