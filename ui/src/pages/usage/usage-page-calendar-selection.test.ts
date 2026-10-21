/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dailyEntry } from "./usage-chart.test-support.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  focusDocument,
  loadUsagePage,
  settleUsageTimers,
  textOf,
  type TestUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  focusDocument();
});

async function loadCalendar(
  cache: "fresh" | "partial",
  daily: ReturnType<typeof dailyEntry>[],
  pending = false,
) {
  const { result: base } = cacheSnapshot(cache);
  const totalTokens = daily.reduce((sum, day) => sum + day.totalTokens, 0);
  const result = {
    ...base,
    ...(!pending ? { startDate: "2026-05-01", endDate: "2026-05-04" } : {}),
    totals: { ...base.totals, totalTokens, ...(!pending ? { input: totalTokens } : {}) },
    sessions: daily.map((day) => ({
      key: `agent:main:${day.date}`,
      label: pending
        ? undefined
        : day.date === "2026-05-03"
          ? "Excluded session"
          : `Usage on ${day.date}`,
      agentId: pending ? undefined : "main",
      usage: {
        ...day,
        activityDates: [day.date],
        dailyBreakdown: [{ ...day, tokens: day.totalTokens, cost: day.totalCost }],
      },
    })),
    aggregates: { ...base.aggregates, costDaily: daily },
  };
  const unresolved = new Promise<never>(() => {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method !== "sessions.usage") {
      return { providers: [] };
    }
    return pending && Array.isArray(params?.selectedDays) ? unresolved : result;
  });
  return { ...(await loadUsagePage(request)), request };
}
const barsIn = (page: TestUsagePage) => [
  ...page.querySelectorAll<HTMLElement>(".daily-bar-wrapper"),
];
const labelOf = (bar: HTMLElement) => textOf(bar, ".daily-bar-label");
const shiftClick = (bar: HTMLElement) =>
  bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));

it.each<["fresh" | "partial", boolean, string[]]>([
  ["fresh", false, ["May 1", "May 2", "May 3", "May 4"]],
  ["partial", false, ["May 2", "May 4"]],
  ["partial", true, ["May 2", "May 4"]],
])(
  "selects the displayed calendar range with Shift-click for %s (filtered: %s)",
  async (cache, filtered, selectedLabels) => {
    const daily = [
      dailyEntry("2026-05-04", 900),
      ...(filtered ? [dailyEntry("2026-05-03", 500)] : []),
      dailyEntry("2026-05-02", 100),
    ];
    const { page } = await loadCalendar(cache, daily);
    const startDate = page.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!;
    startDate.value = "2026-05-01";
    startDate.dispatchEvent(new Event("change", { bubbles: true }));
    await settleUsageTimers(page, 400);

    if (filtered) {
      const query = page.querySelector<HTMLInputElement>(".usage-query-input")!;
      query.value = 'label:"Usage on"';
      query.dispatchEvent(new Event("input", { bubbles: true }));
      query.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await settleUsageTimers(page);
    }

    const bars = () => barsIn(page);
    expect(bars().map(labelOf)).toEqual(selectedLabels);
    const amounts = cache === "fresh" ? [0, 100, 0, 900] : [100, 900];
    expect(bars().map((bar) => bar.getAttribute("aria-label"))).toEqual(
      selectedLabels.map((label, index) => `${label}, 2026: ${amounts[index]} tokens, $0.00`),
    );
    expect(page.querySelectorAll(".daily-bar--empty")).toHaveLength(cache === "fresh" ? 2 : 0);
    expect(textOf(page, ".daily-chart-range")).toContain("May 1, 2026");
    bars()[0]!.click();
    await settleUsageTimers(page);
    shiftClick(bars().at(-1)!);
    await settleUsageTimers(page);

    expect(
      bars()
        .filter((bar) => bar.getAttribute("aria-pressed") === "true")
        .map(labelOf),
    ).toEqual(selectedLabels);
    expect(textOf(page, ".filter-chip-label")).toBe(`Days: ${selectedLabels.length} days`);
    expect(textOf(page, ".usage-metric-badge strong")).toBe("1.0K");
    expect(
      [...page.querySelectorAll(".session-bar-title")].map((row) => row.textContent).toSorted(),
    ).toEqual(["Usage on 2026-05-02", "Usage on 2026-05-04"]);
  },
);

it("keeps the same calendar interactive while day totals are pending", async () => {
  const { page, request } = await loadCalendar(
    "fresh",
    [dailyEntry("2026-05-02", 100), dailyEntry("2026-05-04", 900)],
    true,
  );
  const bars = () => barsIn(page);
  const first = bars()[0]!;
  const last = bars().at(-1)!;
  first.click();
  await page.updateComplete;
  expect(
    [...page.querySelectorAll(".usage-metric-badge strong")].map((node) => node.textContent),
  ).toEqual(["—", "—", "—"]);
  expect(bars()).toContain(last);
  shiftClick(last);
  await page.updateComplete;
  const days = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1]
    ?.selectedDays;
  expect(days).toEqual(expect.arrayContaining(["2026-04-05", "2026-05-04"]));
  expect(Array.isArray(days) && days.length > 1).toBe(true);
});
