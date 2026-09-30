import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import {
  formatSessionSnoozeWakeTime,
  isSessionSnoozed,
  nextSessionSnoozeWakeAt,
  resolveSessionSnoozePresets,
} from "./session-snooze.ts";

describe("session snooze", () => {
  it.each([
    [undefined, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    [0, false],
    [-1, false],
    [99, false],
    [100, false],
    [101, true],
  ])("classifies wake time %s at the deadline boundary", (snoozedUntil, expected) => {
    expect(isSessionSnoozed({ snoozedUntil }, 100)).toBe(expected);
  });

  it.each([
    { now: new Date(2026, 8, 29, 9), evening: true, nextMonday: new Date(2026, 9, 5, 9) },
    { now: new Date(2026, 8, 29, 17, 30), evening: false, nextMonday: new Date(2026, 9, 5, 9) },
    { now: new Date(2026, 8, 27, 9), evening: true, nextMonday: null },
    { now: new Date(2026, 2, 8, 0, 30), evening: true, nextMonday: null },
    { now: new Date(2026, 10, 1, 0, 30), evening: true, nextMonday: null },
  ])("resolves calendar presets for $now", ({ now, evening, nextMonday }) => {
    const before = now.getTime();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
    const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18);
    expect(resolveSessionSnoozePresets(now)).toEqual([
      { id: "hour", snoozedUntil: before + 3_600_000 },
      { id: "three-hours", snoozedUntil: before + 10_800_000 },
      ...(evening ? [{ id: "evening", snoozedUntil: tonight.getTime() }] : []),
      { id: "tomorrow", snoozedUntil: tomorrow.getTime() },
      ...(nextMonday ? [{ id: "next-week", snoozedUntil: nextMonday.getTime() }] : []),
    ]);
    expect(now.getTime()).toBe(before);
  });

  it("omits evening when exactly an hour away and advances Monday to the following week", () => {
    const presets = resolveSessionSnoozePresets(new Date(2026, 8, 28, 17));
    expect(presets.map(({ id }) => id)).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
    expect(presets.at(-1)?.snoozedUntil).toBe(new Date(2026, 9, 5, 9).getTime());
  });

  it("finds the earliest future deadline without retaining expired or malformed values", () => {
    expect(
      nextSessionSnoozeWakeAt(
        [
          {},
          { snoozedUntil: Infinity },
          { snoozedUntil: 100 },
          { snoozedUntil: 300 },
          { snoozedUntil: 200 },
        ],
        100,
      ),
    ).toBe(200);
    expect(nextSessionSnoozeWakeAt([{ snoozedUntil: 100 }], 100)).toBeNull();
    expect(nextSessionSnoozeWakeAt([], 100)).toBeNull();
  });
});

describe("snooze wake-time presentation", () => {
  let restore: () => Promise<void>;
  beforeEach(() => {
    restore = captureI18nStateForTesting();
  });
  afterEach(() => restore());

  it("distinguishes today, tomorrow, the coming week, and later dates", async () => {
    await i18n.setLocale("en");
    const now = new Date(2026, 8, 29, 9);
    expect(formatSessionSnoozeWakeTime(new Date(2026, 8, 29, 18).getTime(), now)).toBe("6:00 PM");
    expect(formatSessionSnoozeWakeTime(new Date(2026, 8, 30, 9).getTime(), now)).toBe(
      "tomorrow 9:00 AM",
    );
    expect(formatSessionSnoozeWakeTime(new Date(2026, 9, 5, 9).getTime(), now)).toMatch(
      /Mon.*9:00 AM/u,
    );
    expect(formatSessionSnoozeWakeTime(new Date(2026, 9, 10, 9).getTime(), now)).toMatch(
      /Oct 10.*9:00 AM/u,
    );
    expect(
      formatSessionSnoozeWakeTime(new Date(2026, 9, 5, 9).getTime(), new Date(2026, 8, 28, 10)),
    ).toMatch(/Mon.*9:00 AM/u);
  });

  it("uses the current UI locale for the wake time", async () => {
    await i18n.setLocale("de");
    expect(
      formatSessionSnoozeWakeTime(new Date(2026, 8, 29, 18).getTime(), new Date(2026, 8, 29, 9)),
    ).toBe("18:00");
  });
});
