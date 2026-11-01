import { afterEach, expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../styles.css";
import "../../styles/usage.css";
import { CostBreakdownCompact, DailyChartCompact } from "./view-chart.tsx";
import { mountView } from "./view-render.test-support.ts";

function chart(
  dailyEntries: Parameters<typeof DailyChartCompact>[0]["dailyEntries"],
  dailyChartMode: "by-provider" | "by-type",
) {
  return DailyChartCompact({
    dailyEntries,
    dailyChartMode,
    selectedDays: [],
    chartMode: "tokens",
    onDailyChartModeChange: () => {},
    providerSeries: [],
    onSelectDay: () => {},
    range: { startDate: dailyEntries[0]!.date, endDate: dailyEntries.at(-1)!.date, complete: true },
  });
}

registerUsageEnglish();
afterEach(() => document.body.replaceChildren());

it.each(["by-provider", "by-type"] as const)(
  "keeps every annual column visible through resize in %s mode",
  async (dailyChartMode) => {
    const { page } = await import("vitest/browser");
    const start = Date.parse("2024-01-01");
    const daily = Array.from({ length: 366 }, (_, index) => ({
      ...createEmptyCostUsageTotals(),
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      input: 100,
      totalTokens: 100,
    }));
    const { container } = mountView(() => chart(daily, dailyChartMode));
    for (const width of [1280, 390]) {
      await page.viewport(width, 800);
      const plot = container.querySelector<HTMLElement>(".daily-chart-bars")!;
      const columns = [...plot.querySelectorAll<HTMLElement>(".daily-bar-wrapper")];
      expect(columns).toHaveLength(366);
      expect(columns.every((column) => column.getBoundingClientRect().width > 0)).toBe(true);
      expect(
        columns.every(
          (column) => column.querySelector(".daily-bar")!.getBoundingClientRect().width > 0,
        ),
      ).toBe(true);
      expect(columns.at(-1)!.getBoundingClientRect().right).toBeLessThanOrEqual(
        plot.getBoundingClientRect().right + 1,
      );
      expect(plot.scrollWidth).toBeLessThanOrEqual(plot.clientWidth + 1);
    }
  },
);

it("keeps token segments proportional and legend markers round beside form styles", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(1100, 800);
  const totals = {
    ...createEmptyCostUsageTotals(),
    input: 10,
    output: 10,
    cacheRead: 80,
    totalTokens: 100,
  };
  const { container } = mountView(() => [
    chart([{ ...totals, date: "2026-09-18" }], "by-type"),
    CostBreakdownCompact({ totals, mode: "tokens" }),
  ]);
  await Promise.all(
    [...container.querySelectorAll("openclaw-tooltip")].map((tooltip) => tooltip.updateComplete),
  );
  const segments = [...container.querySelectorAll<HTMLElement>(".daily-bar .cost-segment")];
  // Cache write is zero, so it draws no segment.
  expect(segments).toHaveLength(3);
  const input = segments[1]!;
  const cacheRead = segments[2]!;
  expect(getComputedStyle(input).paddingTop).toBe("0px");
  expect(
    input.getBoundingClientRect().height / cacheRead.getBoundingClientRect().height,
  ).toBeCloseTo(10 / 80, 1);
  const legend = container.querySelectorAll<HTMLElement>(".legend-dot")[1]!;
  expect(legend.getBoundingClientRect().width).toBeCloseTo(
    legend.getBoundingClientRect().height,
    1,
  );
  expect(legend.getBoundingClientRect().width).toBeLessThanOrEqual(12);
});
