import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatUsageReportLines, formatUsageWindowSummary } from "./provider-usage.format.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12);
const snapshot = (
  windows: ProviderUsageSnapshot["windows"] = [],
  fields: Partial<ProviderUsageSnapshot> = {},
): ProviderUsageSnapshot => ({
  provider: "anthropic",
  displayName: "Claude",
  windows,
  ...fields,
});
const report = (...providers: ProviderUsageSnapshot[]) =>
  formatUsageReportLines({ updatedAt: now, providers });
const window = (label: string, usedPercent: number, resetAt?: number) => ({
  label,
  usedPercent,
  resetAt,
});

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

it("formats reset buckets and clamps remaining percentages", () => {
  const cases = [
    [120, now - 1, /0% left · resets now/],
    [-10, now + 30 * 60_000, /100% left · resets 30m/],
    [30, now + 135 * 60_000, /70% left · resets 2h 15m/],
    [40, now + 51 * 60 * 60_000, /60% left · resets 2d 3h/],
    [50, Date.UTC(2026, 0, 20, 12), /50% left · resets [A-Z][a-z]{2} \d{1,2}/],
    [25, undefined, /75% left/],
  ] as const;
  for (const [usedPercent, resetAt, expected] of cases) {
    expect(report(snapshot([window("Quota", usedPercent, resetAt)]))[2]).toMatch(
      new RegExp(`^    Quota: ${expected.source}$`),
    );
  }
});

it("limits compact windows and includes available resets", () => {
  const provider = snapshot([window("A", 10, now + 60_000), window("B", 20), window("C", 30)]);
  expect(formatUsageWindowSummary(provider)).toBe("A 90% left ⏱1m · B 80% left");
});

it("renders signed balances and budgets on compact and detailed surfaces", () => {
  const provider = snapshot([], {
    plan: "Production",
    billing: [
      { type: "balance", amount: -2.5, unit: "USD" },
      { type: "budget", label: "API key budget", used: 5, limit: 20, unit: "USD" },
    ],
  });
  expect(formatUsageWindowSummary(provider)).toBe("Balance: -$2.50");
  expect(report(provider)).toEqual([
    "Usage:",
    "  Claude (Production)",
    "    Balance: -$2.50",
    "    API key budget: $5.00 / $20.00",
  ]);
});

it("reports provider errors, empty snapshots, summaries, and quota windows", () => {
  const balance = snapshot([], {
    displayName: "DeepSeek",
    summary: "Balance ¥0.00",
    plan: "Unavailable",
  });
  expect(formatUsageWindowSummary(balance)).toBe("Balance ¥0.00");
  expect(
    report(
      snapshot([], { error: "Token expired", plan: "Pro" }),
      snapshot([], { displayName: "Xiaomi" }),
      balance,
      snapshot([window("Daily", 25, now + 120 * 60_000)], { plan: "Pro" }),
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
