/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dailyEntry } from "./usage-chart.test-support.ts";
import {
  cacheSnapshot,
  changeUsageControl,
  cleanupUsagePageTest,
  focusDocument,
  loadUsagePage,
  showRecentSessions,
  queryUsagePage,
  settleUsageTimers,
  textOf,
  type TestUsagePage,
} from "./usage-page.test-support.ts";
import { texts } from "./view-render.test-support.ts";

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
  const modelDaily = daily.map((day, index) => ({
    date: day.date,
    provider: index === 0 ? "openai" : "anthropic",
    model: "synthetic-model",
    tokens: day.totalTokens,
    cost: day.totalCost,
    count: 1,
    ...(day.usageReport ? { usageReport: day.usageReport } : {}),
  }));
  const result = {
    ...base,
    ...(!pending ? { startDate: "2026-05-01", endDate: "2026-05-04" } : {}),
    totals: {
      ...base.totals,
      totalTokens,
      input: pending ? base.totals.input : totalTokens,
      usageReport: daily.find((day) => day.usageReport?.state === "unavailable")?.usageReport,
    },
    sessions: daily.map((day, index) => ({
      key: `agent:main:${day.date}`,
      label: day.date === "2026-05-03" ? "Excluded session" : `Usage on ${day.date}`,
      agentId: "main",
      usage: {
        ...day,
        activityDates: [day.date],
        dailyBreakdown: [{ ...day, tokens: day.totalTokens, cost: day.totalCost }],
        dailyModelUsage: [modelDaily[index]!],
      },
    })),
    aggregates: { ...base.aggregates, costDaily: daily, modelDaily },
  };
  const unresolved = new Promise<never>(() => {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method !== "sessions.usage") {
      return { providers: [] };
    }
    return pending && Array.isArray(params?.selectedDays) ? unresolved : result;
  });
  const loaded = await loadUsagePage(request);
  await showRecentSessions(loaded.page);
  return { ...loaded, request };
}
const barsIn = (page: TestUsagePage) => [
  ...page.querySelectorAll<HTMLElement>(".daily-bar-wrapper"),
];
const labelOf = (bar: HTMLElement) => textOf(bar, ".daily-bar-label");
const shiftClick = (bar: HTMLElement) =>
  bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));

it.each([false, true])(
  "keeps calendar attribution and completeness independent of the selected summary (partial calendar: %s)",
  async (partial) => {
    const { page } = await loadCalendar("fresh", [
      dailyEntry("2026-05-02", 100),
      {
        ...dailyEntry("2026-05-04", 900),
        ...(partial ? { usageReport: { state: "unavailable" as const } } : {}),
      },
    ]);
    const legend = () =>
      texts(page.element, ".daily-chart-legend li", false).map((text) => text.replace(/\s+/g, ""));
    expect(legend()).toEqual(partial ? ["Anthropic", "OpenAI"] : ["Anthropic90%", "OpenAI10%"]);
    barsIn(page)
      .find((bar) => labelOf(bar) === "May 2")!
      .click();
    await settleUsageTimers(page);
    expect(textOf(page, ".usage-metric-badge strong")).toBe("100");
    expect(legend()).toEqual(partial ? ["Anthropic", "OpenAI"] : ["Anthropic90%", "OpenAI10%"]);
    expect(texts(page.element, ".session-bar-title", false)).toEqual(["Usage on 2026-05-02"]);
  },
);

it.each<["fresh" | "partial", boolean, string[]]>([
  ["fresh", false, ["May 1", "May 2", "May 3", "May 4"]],
  ["partial", false, ["May 1", "May 2", "May 3", "May 4"]],
  ["partial", true, ["May 1", "May 2", "May 3", "May 4"]],
])(
  "selects the displayed calendar range with Shift-click for %s (filtered: %s)",
  async (cache, filtered, selectedLabels) => {
    const daily = [
      dailyEntry("2026-05-04", 900),
      ...(filtered ? [dailyEntry("2026-05-03", 500)] : []),
      dailyEntry("2026-05-02", 100),
    ];
    const { page } = await loadCalendar(cache, daily);
    changeUsageControl(
      page.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!,
      "2026-05-01",
    );
    await settleUsageTimers(page, 400);

    if (filtered) {
      await queryUsagePage(page, 'label:"Usage on"');
      await settleUsageTimers(page);
    }

    const bars = () => barsIn(page);
    expect(bars().map(labelOf)).toEqual(selectedLabels);
    const amounts = [0, 100, 0, 900];
    expect(bars().map((bar) => bar.getAttribute("aria-label"))).toEqual(
      selectedLabels.map((label, index) =>
        cache === "partial" && amounts[index] === 0
          ? `${label}, 2026: not loaded yet`
          : `${label}, 2026: ${amounts[index]} tokens, $0.00`,
      ),
    );
    expect(page.querySelectorAll(".daily-bar--empty")).toHaveLength(2);
    expect(page.querySelectorAll(".daily-bar-wrapper--pending")).toHaveLength(
      cache === "fresh" ? 0 : 2,
    );
    bars()[0]!.focus();
    await page.updateComplete;
    expect(textOf(page, ".daily-chart-tip strong")).toBe(
      `May 1, 2026 · ${cache === "partial" ? "not loaded yet" : "0"}`,
    );
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
    expect(texts(page.element, ".session-bar-title", false).toSorted()).toEqual([
      "Usage on 2026-05-02",
      "Usage on 2026-05-04",
    ]);
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
  expect(texts(page.element, ".usage-metric-badge strong", false)).toEqual(["—", "—", "—"]);
  expect(bars()).toContain(last);
  shiftClick(last);
  await page.updateComplete;
  const days = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1]
    ?.selectedDays;
  expect(days).toEqual(expect.arrayContaining(["2026-04-05", "2026-05-04"]));
  expect(Array.isArray(days) && days.length > 1).toBe(true);
});
