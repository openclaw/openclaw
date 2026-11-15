import { afterEach, describe, expect, it, vi } from "vitest";
import { readAutomationNextRun, type AutomationNextRunFacts } from "./presenter.ts";

afterEach(() => void vi.useRealTimers());
const formatAutomationNextRun = (facts: AutomationNextRunFacts, nowMs: number) => {
  vi.useFakeTimers({ toFake: ["Date"], now: nowMs });
  return readAutomationNextRun(facts);
};

const local = (...parts: [number, number, number, number, number, number?]) =>
  new Date(...parts).getTime();
const scheduled = (nextRunAtMs: number | null): AutomationNextRunFacts => ({
  enabled: true,
  running: false,
  autoDisabled: false,
  waiting: false,
  nextRunAtMs,
});

describe("formatAutomationNextRun", () => {
  // Monday, November 9, 2026, 3:03 PM local: the issue's worked examples.
  const now = local(2026, 10, 9, 15, 3);
  const soon = local(2026, 10, 9, 15, 5);
  const tomorrow = local(2026, 10, 10, 9, 0);

  it.each([
    ["repeats every five minutes", scheduled(soon), "Next in 2 min (today at 3:05 PM)"],
    ["repeats daily", scheduled(tomorrow), "Next in 18 hours (tomorrow at 9:00 AM)"],
    ["runs once today", scheduled(soon), "Next in 2 min (today at 3:05 PM)"],
    ["runs once tomorrow", scheduled(tomorrow), "Next in 18 hours (tomorrow at 9:00 AM)"],
    [
      "runs on a later date",
      scheduled(local(2026, 10, 15, 9, 0)),
      "Next in 6 days (Nov 15 at 9:00 AM)",
    ],
    // The authored 2:51 PM occurrence is not an input; only the rearmed deadline is.
    ["agent scheduled another check", scheduled(soon), "Next in 2 min (today at 3:05 PM)"],
    ["running", { ...scheduled(soon), running: true, waiting: true }, "Running"],
    ["paused", { ...scheduled(null), enabled: false }, "Paused"],
    ["waiting", { ...scheduled(local(2026, 10, 9, 14, 0)), waiting: true }, "Waiting"],
    ["no next run", scheduled(null), "No run scheduled"],
    [
      "auto-disabled",
      { ...scheduled(null), enabled: false, autoDisabled: true },
      "No run scheduled",
    ],
  ] satisfies [string, AutomationNextRunFacts, string][])("%s", (_name, facts, expected) => {
    expect(formatAutomationNextRun(facts, now)).toBe(expected);
  });

  it("reports a passed deadline that has not started as due, never a negative countdown", () => {
    expect(formatAutomationNextRun(scheduled(now - 60_000), now)).toBe("Due now");
    expect(formatAutomationNextRun(scheduled(now), now)).toBe("Due now");
    expect(formatAutomationNextRun(scheduled(now + 45_000), now)).toBe(
      "Next in 45 sec (today at 3:03 PM)",
    );
  });

  it("re-derives the calendar day and countdown from the same deadline across midnight and years", () => {
    const halfPast = local(2026, 10, 10, 0, 30);
    expect(formatAutomationNextRun(scheduled(halfPast), local(2026, 10, 9, 23, 59, 30))).toBe(
      "Next in 31 min (tomorrow at 12:30 AM)",
    );
    expect(formatAutomationNextRun(scheduled(halfPast), local(2026, 10, 10, 0, 0, 30))).toBe(
      "Next in 30 min (today at 12:30 AM)",
    );
    const newYearsEve = local(2026, 11, 31, 15, 0);
    expect(formatAutomationNextRun(scheduled(local(2027, 0, 1, 9, 0)), newYearsEve)).toBe(
      "Next in 18 hours (tomorrow at 9:00 AM)",
    );
    expect(formatAutomationNextRun(scheduled(local(2027, 0, 5, 9, 0)), newYearsEve)).toBe(
      "Next in 5 days (Jan 5, 2027 at 9:00 AM)",
    );
  });
});
