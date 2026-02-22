import { describe, expect, it } from "vitest";
import {
  formatInboundTime,
  formatInboundDateTime,
  resolveInboundTime,
  type InboundTimeParams,
} from "./inbound-meta.js";

// Fixed timestamp: Sat 15 Feb 2025 7:13am NZDT (UTC+13)
// UTC: Fri 14 Feb 2025 18:13:00
const FIXED_TS = new Date("2025-02-14T18:13:00Z").getTime();
const TZ = "Pacific/Auckland";

describe("formatInboundTime", () => {
  it("formats time with lowercase am/pm, no space, no leading zero", () => {
    const result = formatInboundTime(new Date(FIXED_TS), TZ);
    expect(result).toBe("7:13am");
  });

  it("formats pm times correctly", () => {
    // 14:30 NZDT = 01:30 UTC
    const ts = new Date("2025-02-15T01:30:00Z").getTime();
    const result = formatInboundTime(new Date(ts), TZ);
    expect(result).toBe("2:30pm");
  });

  it("formats 12:00pm (noon) correctly", () => {
    // 12:00 NZDT = 23:00 UTC previous day
    const ts = new Date("2025-02-14T23:00:00Z").getTime();
    const result = formatInboundTime(new Date(ts), TZ);
    expect(result).toBe("12:00pm");
  });

  it("formats 12:00am (midnight) correctly", () => {
    // 00:00 NZDT = 11:00 UTC previous day
    const ts = new Date("2025-02-14T11:00:00Z").getTime();
    const result = formatInboundTime(new Date(ts), TZ);
    expect(result).toBe("12:00am");
  });

  it("formats with different timezone", () => {
    const result = formatInboundTime(new Date(FIXED_TS), "America/New_York");
    // 18:13 UTC = 1:13pm EST
    expect(result).toBe("1:13pm");
  });
});

describe("formatInboundDateTime", () => {
  it("formats full date+time with timezone abbreviation", () => {
    const result = formatInboundDateTime(new Date(FIXED_TS), TZ);
    // Timezone abbreviation varies by environment (NZDT vs GMT+13)
    expect(result).toMatch(/^Sat 15 Feb 7:13am (NZDT|GMT\+13)$/);
  });

  it("includes correct day of week", () => {
    // Sunday: 16 Feb NZDT = 15 Feb UTC 11:00
    const ts = new Date("2025-02-15T11:00:00Z").getTime();
    const result = formatInboundDateTime(new Date(ts), TZ);
    expect(result).toMatch(/^Sun 16 Feb/);
  });
});

describe("resolveInboundTime", () => {
  const baseParams: InboundTimeParams = {
    agentDefaults: { userTimezone: TZ },
    isFirstMessage: false,
    lastTimeSentAt: undefined,
    lastDateSentAt: undefined,
  };

  it("returns full date on first message", () => {
    const result = resolveInboundTime(FIXED_TS, { ...baseParams, isFirstMessage: true });
    expect(result.value).toMatch(/^Sat 15 Feb 7:13am (NZDT|GMT\+13)$/);
    expect(result.isFullDate).toBe(true);
  });

  it("returns full date when lastDateSentAt is undefined (never sent)", () => {
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: FIXED_TS - 60_000,
      lastDateSentAt: undefined,
    });
    expect(result.isFullDate).toBe(true);
    expect(result.value).toContain("Feb");
  });

  it("returns full date when gap >= dateMs (2hrs)", () => {
    const twoHoursAgo = FIXED_TS - 7_200_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: twoHoursAgo,
      lastDateSentAt: twoHoursAgo,
    });
    expect(result.isFullDate).toBe(true);
    expect(result.value).toContain("Feb");
  });

  it("returns time-only when gap >= skipMs (90s) but < dateMs", () => {
    const twoMinAgo = FIXED_TS - 120_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: twoMinAgo,
      lastDateSentAt: twoMinAgo,
    });
    expect(result.value).toBe("7:13am");
    expect(result.isFullDate).toBe(false);
  });

  it("omits t field when gap < skipMs (rapid-fire)", () => {
    const thirtySecAgo = FIXED_TS - 30_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: thirtySecAgo,
      lastDateSentAt: thirtySecAgo,
    });
    expect(result.value).toBeUndefined();
    expect(result.isFullDate).toBe(false);
  });

  it("includes time-only when maxGap exceeded even during rapid-fire", () => {
    // lastTimeSentAt was 16 minutes ago (> 15min maxGap)
    // but lastDateSentAt was also 16 minutes ago (< 2hrs dateMs)
    const sixteenMinAgo = FIXED_TS - 960_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: sixteenMinAgo,
      lastDateSentAt: sixteenMinAgo,
    });
    // Gap of 960s > 90s skipMs, so it would be time-only anyway
    expect(result.value).toBe("7:13am");
    expect(result.isFullDate).toBe(false);
  });

  it("returns undefined when feature is off", () => {
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      agentDefaults: { envelopeInboundTime: "off" },
    });
    expect(result.value).toBeUndefined();
  });

  it("exactly on skipMs boundary includes time", () => {
    const exactlySkipAgo = FIXED_TS - 90_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: exactlySkipAgo,
      lastDateSentAt: exactlySkipAgo,
    });
    expect(result.value).toBe("7:13am");
  });

  it("exactly on dateMs boundary includes full date", () => {
    const exactlyDateAgo = FIXED_TS - 7_200_000;
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: exactlyDateAgo,
      lastDateSentAt: exactlyDateAgo,
    });
    expect(result.isFullDate).toBe(true);
  });

  it("respects custom skipMs config", () => {
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      agentDefaults: { userTimezone: TZ, envelopeInboundTimeSkipMs: 60_000 },
      lastTimeSentAt: FIXED_TS - 50_000,
      lastDateSentAt: FIXED_TS - 50_000,
    });
    expect(result.value).toBeUndefined();
  });

  it("respects custom dateMs config", () => {
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      agentDefaults: { userTimezone: TZ, envelopeInboundTimeDateMs: 3_600_000 },
      lastTimeSentAt: FIXED_TS - 3_600_000,
      lastDateSentAt: FIXED_TS - 3_600_000,
    });
    expect(result.isFullDate).toBe(true);
  });

  it("works with no agentDefaults (uses all defaults)", () => {
    const result = resolveInboundTime(FIXED_TS, {
      isFirstMessage: true,
      lastTimeSentAt: undefined,
      lastDateSentAt: undefined,
    });
    expect(result.isFullDate).toBe(true);
    expect(result.value).toBeDefined();
  });

  it("maxGap forces time-only even when recent rapid-fire would skip", () => {
    // Scenario: lastTimeSentAt was 16 min ago, messages have been rapid since then
    // but we haven't actually sent a t field since 16 min ago
    // Gap of 960_000 > maxGap 900_000, AND > skipMs 90_000
    // This should include time-only
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      lastTimeSentAt: FIXED_TS - 960_000,
      lastDateSentAt: FIXED_TS - 960_000,
    });
    expect(result.value).toBe("7:13am");
    expect(result.isFullDate).toBe(false);
  });

  it("maxGap takes priority over skipMs when maxGapMs < skipMs (custom config)", () => {
    // Edge case: user configures maxGapMs (5min) < skipMs (10min)
    // Gap of 6 min should trigger maxGap override even though it's < skipMs
    const result = resolveInboundTime(FIXED_TS, {
      ...baseParams,
      agentDefaults: {
        userTimezone: TZ,
        envelopeInboundTimeSkipMs: 600_000, // 10 min
        envelopeInboundTimeMaxGapMs: 300_000, // 5 min
      },
      lastTimeSentAt: FIXED_TS - 360_000, // 6 min ago
      lastDateSentAt: FIXED_TS - 360_000,
    });
    expect(result.value).toBe("7:13am");
    expect(result.isFullDate).toBe(false);
  });
});
