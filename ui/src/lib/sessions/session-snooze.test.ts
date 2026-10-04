import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import {
  formatSessionSnoozeWakeTime,
  nextSessionSnoozeWakeAt,
  resolveSessionSnoozePresets,
} from "./session-snooze.ts";

describe("session snooze", () => {
  it.each([
    { now: new Date(2026, 8, 29, 9), evening: true, nextMonday: new Date(2026, 9, 5, 9) },
    { now: new Date(2026, 8, 28, 17), evening: false, nextMonday: new Date(2026, 9, 5, 9) },
    { now: new Date(2026, 8, 27, 9), evening: true, nextMonday: null },
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

  it("finds the earliest future deadline without retaining expired or malformed values", () => {
    expect(
      nextSessionSnoozeWakeAt(
        [undefined, Infinity, 100, 300, 200].map((snoozedUntil) => ({
          snoozedUntil,
        })),
        100,
      ),
    ).toBe(200);
    for (const snoozedUntil of [undefined, Number.NaN, Infinity, -Infinity, 0, -1, 99, 100]) {
      expect(nextSessionSnoozeWakeAt([{ snoozedUntil }], 100)).toBeNull();
    }
    expect(nextSessionSnoozeWakeAt([], 100)).toBeNull();
    expect(nextSessionSnoozeWakeAt([{ snoozedUntil: 101 }], 100)).toBe(101);
  });
});

describe("snooze wake-time presentation", () => {
  let restore: () => Promise<void>;
  beforeEach(() => {
    restore = captureI18nStateForTesting();
  });
  afterEach(() => restore());

  it("formats wake dates relative to today in the current UI locale", async () => {
    const today = new Date(2026, 8, 29, 9);
    for (const [locale, wake, now, expected] of [
      ["en", new Date(2026, 8, 29, 18), today, "6:00 PM"],
      ["en", new Date(2026, 8, 30, 9), today, "tomorrow 9:00 AM"],
      ["en", new Date(2026, 9, 5, 9), today, /Mon.*9:00 AM/u],
      ["en", new Date(2026, 9, 10, 9), today, /Oct 10.*9:00 AM/u],
      ["en", new Date(2026, 9, 5, 9), new Date(2026, 8, 28, 10), /Mon.*9:00 AM/u],
      ["de", new Date(2026, 8, 29, 18), today, "18:00"],
    ] as const) {
      await i18n.setLocale(locale);
      const formatted = formatSessionSnoozeWakeTime(wake.getTime(), now);
      if (typeof expected === "string") {
        expect(formatted).toBe(expected);
      } else {
        expect(formatted).toMatch(expected);
      }
    }
  });
});
