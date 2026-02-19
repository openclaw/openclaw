import { describe, expect, it } from "vitest";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  formatUsageWindowSummary,
} from "./provider-usage.format.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12, 0, 0);

function makeSnapshot(windows: ProviderUsageSnapshot["windows"]): ProviderUsageSnapshot {
  return {
    provider: "anthropic",
    displayName: "Claude",
    windows,
  };
}

describe("provider-usage.format", () => {
  it("returns null summary for errored or empty snapshots", () => {
    expect(formatUsageWindowSummary({ ...makeSnapshot([]), error: "HTTP 401" })).toBeNull();
    expect(formatUsageWindowSummary(makeSnapshot([]))).toBeNull();
  });

  it("formats reset windows across now/minute/hour/day/date buckets", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Now", usedPercent: 10, resetAt: now - 1 },
        { label: "Minute", usedPercent: 20, resetAt: now + 30 * 60_000 },
        { label: "Hour", usedPercent: 30, resetAt: now + 2 * 60 * 60_000 + 15 * 60_000 },
        { label: "Day", usedPercent: 40, resetAt: now + (2 * 24 + 3) * 60 * 60_000 },
        { label: "Date", usedPercent: 50, resetAt: Date.UTC(2026, 0, 20, 12, 0, 0) },
      ]),
      { now, includeResets: true },
    );

    expect(summary).toContain("Now 90% left ⏱now");
    expect(summary).toContain("Minute 80% left ⏱30m");
    expect(summary).toContain("Hour 70% left ⏱2h 15m");
    expect(summary).toContain("Day 60% left ⏱2d 3h");
    expect(summary).toMatch(/Date 50% left ⏱[A-Z][a-z]{2} \d{1,2}/);
  });

  it("honors max windows and reset toggle", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "A", usedPercent: 10, resetAt: now + 60_000 },
        { label: "B", usedPercent: 20, resetAt: now + 120_000 },
        { label: "C", usedPercent: 30, resetAt: now + 180_000 },
      ]),
      { now, maxWindows: 2, includeResets: false },
    );

    expect(summary).toBe("A 90% left · B 80% left");
  });

  it("formats summary line from highest-usage window and provider cap", () => {
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 20 },
            { label: "Week", usedPercent: 70 },
          ],
        },
        {
          provider: "zai",
          displayName: "z.ai",
          windows: [{ label: "Day", usedPercent: 10 }],
        },
      ],
    };

    expect(formatUsageSummaryLine(summary, { now, maxProviders: 1 })).toBe(
      "📊 Usage: Claude 30% left (Week)",
    );
  });

  it("formats report output for empty, error, no-data, and plan entries", () => {
    expect(formatUsageReportLines({ updatedAt: now, providers: [] })).toEqual([
      "Usage: no provider usage available.",
    ]);

    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
          plan: "Plus",
        },
        {
          provider: "xiaomi",
          displayName: "Xiaomi",
          windows: [],
        },
      ],
    };
    expect(formatUsageReportLines(summary)).toEqual([
      "Usage:",
      "  Codex (Plus): Token expired",
      "  Xiaomi: no data",
    ]);
  });
});
