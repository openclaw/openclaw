import { describe, expect, it } from "vitest";
import { formatUsageReportLines, formatUsageWindowSummary } from "./provider-usage.format.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12);
const snapshot = (windows: ProviderUsageSnapshot["windows"]): ProviderUsageSnapshot => ({
  provider: "anthropic",
  displayName: "Claude",
  windows,
});

describe("provider usage formatting", () => {
  it("formats reset buckets and clamps remaining percentages", () => {
    const result = formatUsageWindowSummary(
      snapshot([
        { label: "Now", usedPercent: 120, resetAt: now - 1 },
        { label: "Minute", usedPercent: -10, resetAt: now + 30 * 60_000 },
        { label: "Hour", usedPercent: 30, resetAt: now + 135 * 60_000 },
        { label: "Day", usedPercent: 40, resetAt: now + 51 * 60 * 60_000 },
        { label: "Date", usedPercent: 50, resetAt: Date.UTC(2026, 0, 20, 12) },
        { label: "Unknown", usedPercent: 25 },
      ]),
      { now, maxWindows: 0, includeResets: true },
    );
    expect(result).toContain("Now 0% left ⏱now");
    expect(result).toContain("Minute 100% left ⏱30m");
    expect(result).toContain("Hour 70% left ⏱2h 15m");
    expect(result).toContain("Day 60% left ⏱2d 3h");
    expect(result).toMatch(/Date 50% left ⏱[A-Z][a-z]{2} \d{1,2}/);
    expect(result).toContain("Unknown 75% left");
  });

  it("limits compact windows and suppresses resets", () => {
    expect(
      formatUsageWindowSummary(
        snapshot([
          { label: "A", usedPercent: 10, resetAt: now + 60_000 },
          { label: "B", usedPercent: 20 },
          { label: "C", usedPercent: 30 },
        ]),
        { now, maxWindows: 2 },
      ),
    ).toBe("A 90% left · B 80% left");
  });

  it("renders signed balances and budgets on compact and detailed surfaces", () => {
    const provider: ProviderUsageSnapshot = {
      provider: "openrouter",
      displayName: "OpenRouter",
      plan: "Production",
      windows: [],
      billing: [
        { type: "balance", amount: -2.5, unit: "USD" },
        { type: "budget", label: "API key budget", used: 5, limit: 20, unit: "USD" },
      ],
    };
    expect(formatUsageWindowSummary(provider)).toBe("Balance: -$2.50");
    expect(formatUsageReportLines({ updatedAt: now, providers: [provider] })).toEqual([
      "Usage:",
      "  OpenRouter (Production)",
      "    Balance: -$2.50",
      "    API key budget: $5.00 / $20.00",
    ]);
  });

  it("reports provider errors, empty snapshots, summaries, and quota windows", () => {
    const balance = {
      ...snapshot([]),
      provider: "deepseek",
      displayName: "DeepSeek",
      summary: "Balance ¥0.00",
      plan: "Unavailable",
    };
    expect(formatUsageWindowSummary(balance)).toBe("Balance ¥0.00");
    expect(
      formatUsageReportLines(
        {
          updatedAt: now,
          providers: [
            { ...snapshot([]), error: "Token expired", plan: "Pro" },
            { ...snapshot([]), displayName: "Xiaomi" },
            balance,
            {
              ...snapshot([{ label: "Daily", usedPercent: 25, resetAt: now + 120 * 60_000 }]),
              plan: "Pro",
            },
          ],
        },
        { now },
      ),
    ).toEqual([
      "Usage:",
      "  Claude (Pro): Token expired",
      "  Xiaomi: no data",
      "  DeepSeek (Unavailable): Balance ¥0.00",
      "  Claude (Pro)",
      "    Daily: 75% left · resets 2h",
    ]);
  });

  it("says how old runtime-observed windows are", () => {
    const observed = {
      ...snapshot([{ label: "5h", usedPercent: 56, resetAt: now + 2 * 60 * 60_000 }]),
      provider: "claude-cli",
      displayName: "Claude Code",
    };
    expect(
      formatUsageWindowSummary({ ...observed, observedAt: now - 3 * 60 * 60_000 }, { now }),
    ).toBe("5h 44% left · as of 3h ago");
    expect(
      formatUsageReportLines(
        { updatedAt: now, providers: [{ ...observed, observedAt: now - 12 * 60_000 }] },
        { now },
      ),
    ).toEqual(["Usage:", "  Claude Code (as of 12m ago)", "    5h: 44% left · resets 2h"]);
  });

  it("reports when no provider usage is available", () => {
    expect(formatUsageReportLines({ updatedAt: now, providers: [] })).toEqual([
      "Usage: no provider usage available.",
    ]);
  });
});
