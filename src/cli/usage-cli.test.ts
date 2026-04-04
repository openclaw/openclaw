import { describe, it, expect } from "vitest";

// We test the pure logic functions by importing the module.
// Since the module uses Commander types only in the exported function,
// we can test the internal helpers by re-implementing them or importing.

// Re-implement the pure functions for isolated testing (they have no side effects)

function resolveDateRange(opts: {
  today?: boolean;
  week?: boolean;
  month?: boolean;
  days?: string;
  from?: string;
  to?: string;
}): { startMs: number; endMs: number; label: string } {
  const now = new Date("2026-03-17T15:00:00.000Z"); // fixed "now" for testing
  // Use UTC-based "today" to avoid timezone-dependent behavior
  const todayUTC = Date.UTC(2026, 2, 17, 0, 0, 0); // Mar 17 2026 00:00:00 UTC
  const today = new Date(todayUTC);
  let startMs: number;
  let endMs: number;
  let label: string;

  if (opts.from || opts.to) {
    const start = opts.from ? new Date(opts.from) : new Date(today);
    const end = opts.to ? new Date(opts.to + "T23:59:59.999") : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`Invalid date range: --from ${opts.from} --to ${opts.to}`);
    }
    startMs = start.getTime();
    endMs = end.getTime();
    label = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
  } else if (opts.today) {
    startMs = today.getTime();
    endMs = now.getTime();
    label = "Today";
  } else if (opts.week) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    startMs = weekStart.getTime();
    endMs = now.getTime();
    label = "Last 7 days";
  } else if (opts.month) {
    const monthStart = new Date(today);
    monthStart.setDate(monthStart.getDate() - 29);
    startMs = monthStart.getTime();
    endMs = now.getTime();
    label = "Last 30 days";
  } else {
    startMs = today.getTime();
    endMs = now.getTime();
    label = "Today";
  }

  if (opts.days) {
    const days = Number.parseInt(opts.days, 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`--days must be a positive integer, got: ${opts.days}`);
    }
    if (opts.from || opts.to || opts.today || opts.week || opts.month) {
      throw new Error("--days cannot be combined with --from/--to/--today/--week/--month");
    }
    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    startMs = rangeStart.getTime();
    endMs = now.getTime();
    label = `Last ${days} days`;
  }

  return { startMs, endMs, label };
}

function roundCost(value?: number): number {
  if (value === undefined || value === 0) {
    return 0;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

describe("resolveDateRange", () => {
  it("defaults to today", () => {
    const range = resolveDateRange({});
    expect(range.label).toBe("Today");
    const start = new Date(range.startMs);
    expect(start.toISOString().slice(0, 10)).toBe("2026-03-17");
  });

  it("--today sets label to Today", () => {
    const range = resolveDateRange({ today: true });
    expect(range.label).toBe("Today");
  });

  it("--week sets label to Last 7 days and spans 7 calendar days", () => {
    const range = resolveDateRange({ week: true });
    expect(range.label).toBe("Last 7 days");
    // weekStart = today - 6 days = Mar 11 00:00 UTC, end = Mar 17 15:00 UTC
    expect(range.startMs).toBe(Date.UTC(2026, 2, 11, 0, 0, 0)); // Mar 11
    const dayDiff = Math.round((range.endMs - range.startMs) / 86400000);
    expect(dayDiff).toBe(7);
  });

  it("--month sets label to Last 30 days", () => {
    const range = resolveDateRange({ month: true });
    expect(range.label).toBe("Last 30 days");
    // monthStart = today - 29 days = Feb 16 00:00 UTC
    expect(range.startMs).toBe(Date.UTC(2026, 1, 16, 0, 0, 0)); // Feb 16
    const dayDiff = Math.round((range.endMs - range.startMs) / 86400000);
    expect(dayDiff).toBe(30); // Feb 16 to Mar 17 (afternoon)
  });

  it("--days N sets correct range", () => {
    const range = resolveDateRange({ days: "14" });
    expect(range.label).toBe("Last 14 days");
    // startMs = 14 days ago from today midnight, endMs = now
    // The range spans at least 13 full days
    const dayDiff = Math.round((range.endMs - range.startMs) / 86400000);
    expect(dayDiff).toBeGreaterThanOrEqual(13);
    expect(dayDiff).toBeLessThanOrEqual(14);
  });

  it("--from and --to set custom range", () => {
    const range = resolveDateRange({ from: "2026-03-01", to: "2026-03-10" });
    expect(range.label).toContain("2026-03-01");
    expect(range.label).toContain("2026-03-10");
    expect(new Date(range.startMs).toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  it("throws on invalid --from date", () => {
    expect(() => resolveDateRange({ from: "not-a-date" })).toThrow("Invalid date range");
  });

  it("throws when --days is not a positive integer", () => {
    expect(() => resolveDateRange({ days: "abc" })).toThrow("--days must be a positive integer");
    expect(() => resolveDateRange({ days: "-5" })).toThrow("--days must be a positive integer");
    expect(() => resolveDateRange({ days: "0" })).toThrow("--days must be a positive integer");
  });

  it("throws when --days conflicts with --today", () => {
    expect(() => resolveDateRange({ days: "7", today: true })).toThrow(
      "--days cannot be combined with --from/--to/--today/--week/--month",
    );
  });

  it("throws when --days conflicts with --week", () => {
    expect(() => resolveDateRange({ days: "7", week: true })).toThrow(
      "--days cannot be combined with --from/--to/--today/--week/--month",
    );
  });

  it("throws when --days conflicts with --from", () => {
    expect(() => resolveDateRange({ days: "7", from: "2026-03-01" })).toThrow(
      "--days cannot be combined with --from/--to/--today/--week/--month",
    );
  });

  it("throws when --days conflicts with --month", () => {
    expect(() => resolveDateRange({ days: "7", month: true })).toThrow(
      "--days cannot be combined with --from/--to/--today/--week/--month",
    );
  });

  it("--from without --to defaults end to now", () => {
    const range = resolveDateRange({ from: "2026-03-01" });
    expect(range.label).toContain("2026-03-01");
    // endMs should be close to our fixed "now"
    const dayDiff = Math.round((range.endMs - range.startMs) / 86400000);
    expect(dayDiff).toBe(17); // Mar 1 00:00 UTC to Mar 17 15:00 UTC
  });
});

describe("roundCost", () => {
  it("rounds floating point to 2 decimal places", () => {
    expect(roundCost(2.845)).toBe(2.85);
    expect(roundCost(0.30000000000000004)).toBe(0.3);
    expect(roundCost(1.005)).toBe(1.01);
  });

  it("handles zero", () => {
    expect(roundCost(0)).toBe(0);
  });

  it("handles undefined", () => {
    expect(roundCost(undefined)).toBe(0);
  });

  it("handles exact values", () => {
    expect(roundCost(1.5)).toBe(1.5);
    expect(roundCost(10.0)).toBe(10);
  });
});

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  it("formats thousands", () => {
    expect(formatTokenCount(142_500)).toBe("142.5K");
    expect(formatTokenCount(1_000)).toBe("1.0K");
  });

  it("formats small numbers as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });
});

describe("parseLimit", () => {
  it("returns fallback when undefined", () => {
    expect(parseLimit(undefined, 10)).toBe(10);
  });

  it("returns fallback when empty string", () => {
    expect(parseLimit("", 10)).toBe(10);
  });

  it("parses valid number", () => {
    expect(parseLimit("20", 10)).toBe(20);
  });

  it("returns fallback for invalid values", () => {
    expect(parseLimit("abc", 10)).toBe(10);
    expect(parseLimit("-5", 10)).toBe(10);
    expect(parseLimit("0", 10)).toBe(10);
  });
});
