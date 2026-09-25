// Regression: recencyGroup compared day starts with a fixed 24h duration, so
// proposals from the previous local calendar day grouped as "earlier" when the
// intervening day spanned 23 or 25 hours (DST transitions), and a naive
// setDate(-1) from the day start misses zones where local midnight is skipped
// (America/Santiago). The host timezone is simulated with a Date shim driven
// by Intl.DateTimeFormat, because worker-thread runners ignore process.env.TZ.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recencyGroup } from "./proposal-records.ts";

type WallClock = [
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
];

// Captured before installZonedDate replaces the global; FakeDate has no UTC.
const RealDate = Date;

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

// Inverts zonedParts by fixed-point iteration; converges for the anchored
// (noon) wall clocks used here, which are never skipped or ambiguous hours.
function zonedWallClockToMs([y, mo, d, h, mi, s]: WallClock, timeZone: string): number {
  let guess = RealDate.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(guess, timeZone);
    const diff =
      RealDate.UTC(y, mo - 1, d, h, mi, s) - RealDate.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (diff === 0) {
      return guess;
    }
    guess += diff;
  }
  return guess;
}

// Minimal Date surface used by recencyGroup, with local calendar reads routed
// through the simulated zone instead of the host timezone.
function installZonedDate(timeZone: string, nowMs: number) {
  class FakeDate {
    #ms: number;

    constructor(...args: number[]) {
      if (args.length === 0) {
        this.#ms = nowMs;
      } else if (args.length === 1) {
        this.#ms = args[0];
      } else {
        const [y, mo, d = 1, h = 0, mi = 0, s = 0] = args;
        this.#ms = zonedWallClockToMs([y, mo + 1, d, h, mi, s], timeZone);
      }
    }

    getFullYear(): number {
      return zonedParts(this.#ms, timeZone).y;
    }

    getMonth(): number {
      return zonedParts(this.#ms, timeZone).mo - 1;
    }

    getDate(): number {
      return zonedParts(this.#ms, timeZone).d;
    }

    getTime(): number {
      return this.#ms;
    }

    setDate(d: number): number {
      const p = zonedParts(this.#ms, timeZone);
      this.#ms = zonedWallClockToMs([p.y, p.mo, d, p.h, p.mi, p.s], timeZone);
      return this.#ms;
    }

    static now(): number {
      return nowMs;
    }
  }
  vi.stubGlobal("Date", FakeDate);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DST_CASES: Array<{ timeZone: string; now: WallClock; previousDay: WallClock }> = [
  // 23-hour day: US spring forward.
  {
    timeZone: "America/New_York",
    now: [2026, 3, 9, 12, 0, 0],
    previousDay: [2026, 3, 8, 12, 0, 0],
  },
  // 25-hour day: US fall back.
  {
    timeZone: "America/New_York",
    now: [2026, 11, 2, 12, 0, 0],
    previousDay: [2026, 11, 1, 12, 0, 0],
  },
  // Local midnight is skipped entirely on this date.
  {
    timeZone: "America/Santiago",
    now: [2026, 9, 6, 12, 0, 0],
    previousDay: [2026, 9, 5, 12, 0, 0],
  },
];

describe("recencyGroup", () => {
  it.each(DST_CASES)(
    "groups the previous local calendar day as yesterday ($timeZone, $now.0-$now.1-$now.2)",
    ({ timeZone, now, previousDay }) => {
      const nowMs = zonedWallClockToMs(now, timeZone);
      installZonedDate(timeZone, nowMs);
      expect(recencyGroup(zonedWallClockToMs(previousDay, timeZone))).toBe("yesterday");
    },
  );

  it("keeps same-day proposals as today and older ones as earlier", () => {
    const timeZone = "America/New_York";
    const nowMs = zonedWallClockToMs([2026, 3, 9, 12, 0, 0], timeZone);
    installZonedDate(timeZone, nowMs);
    expect(recencyGroup(nowMs)).toBe("today");
    expect(recencyGroup(zonedWallClockToMs([2026, 3, 9, 0, 30, 0], timeZone))).toBe("today");
    expect(recencyGroup(zonedWallClockToMs([2026, 3, 7, 12, 0, 0], timeZone))).toBe("earlier");
  });

  it("handles the previous day across a month boundary", () => {
    const timeZone = "America/New_York";
    const nowMs = zonedWallClockToMs([2026, 4, 1, 12, 0, 0], timeZone);
    installZonedDate(timeZone, nowMs);
    expect(recencyGroup(zonedWallClockToMs([2026, 3, 31, 12, 0, 0], timeZone))).toBe("yesterday");
    expect(recencyGroup(zonedWallClockToMs([2026, 3, 30, 12, 0, 0], timeZone))).toBe("earlier");
  });
});
