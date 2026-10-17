/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  createPage,
  focusDocument,
  preloadUsage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

it.each([
  {
    cache: "fresh" as const,
    filtered: false,
    selectedLabels: ["May 1", "May 2", "May 3", "May 4"],
  },
  { cache: "partial" as const, filtered: false, selectedLabels: ["May 2", "May 4"] },
  { cache: "partial" as const, filtered: true, selectedLabels: ["May 2", "May 4"] },
])(
  "selects the displayed calendar range with Shift-click for a $cache report (filtered: $filtered)",
  async ({ cache, filtered, selectedLabels }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
    focusDocument();
    const snapshot = cacheSnapshot(cache);
    const daily = [
      dailyEntry("2026-05-04", 900),
      ...(filtered ? [dailyEntry("2026-05-03", 500)] : []),
      dailyEntry("2026-05-02", 100),
    ];
    const totalTokens = daily.reduce((sum, day) => sum + day.totalTokens, 0);
    const result = {
      ...snapshot.result,
      startDate: "2026-05-01",
      endDate: "2026-05-04",
      totals: { ...snapshot.result.totals, input: totalTokens, totalTokens },
      sessions: daily.map((day) => ({
        key: `agent:main:${day.date}`,
        label: day.date === "2026-05-03" ? "Excluded session" : `Usage on ${day.date}`,
        agentId: "main",
        usage: {
          ...day,
          activityDates: [day.date],
          dailyBreakdown: [{ ...day, tokens: day.totalTokens, cost: day.totalCost }],
        },
      })),
      aggregates: { ...snapshot.result.aggregates, costDaily: daily },
    };
    const request = vi.fn(async (method: string) =>
      method === "sessions.usage" ? result : { providers: [] },
    );
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    const startDate = page.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!;
    startDate.value = "2026-05-01";
    startDate.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    await page.updateComplete;

    if (filtered) {
      const query = page.querySelector<HTMLInputElement>(".usage-query-input")!;
      query.value = 'label:"Usage on"';
      query.dispatchEvent(new Event("input", { bubbles: true }));
      query.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
    }

    const bars = () => [...page.querySelectorAll<HTMLElement>(".daily-bar-wrapper")];
    expect(bars().map((bar) => bar.querySelector(".daily-bar-label")?.textContent)).toEqual(
      selectedLabels,
    );
    expect(bars().map((bar) => bar.getAttribute("aria-label"))).toEqual(
      cache === "fresh"
        ? [
            "May 1, 2026: 0 tokens, $0.00",
            "May 2, 2026: 100 tokens, $0.00",
            "May 3, 2026: 0 tokens, $0.00",
            "May 4, 2026: 900 tokens, $0.00",
          ]
        : ["May 2, 2026: 100 tokens, $0.00", "May 4, 2026: 900 tokens, $0.00"],
    );
    expect(page.querySelectorAll(".daily-bar--empty")).toHaveLength(cache === "fresh" ? 2 : 0);
    expect(page.querySelector(".daily-chart-range")?.textContent).toContain("May 1, 2026");
    bars()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    bars()
      .at(-1)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(
      bars()
        .filter((bar) => bar.getAttribute("aria-pressed") === "true")
        .map((bar) => bar.querySelector(".daily-bar-label")?.textContent),
    ).toEqual(selectedLabels);
    expect(page.querySelector(".filter-chip-label")?.textContent).toBe(
      `Days: ${selectedLabels.length} days`,
    );
    expect(page.querySelector(".usage-metric-badge strong")?.textContent).toBe("1.0K");
    expect(
      [...page.querySelectorAll(".session-bar-title")].map((row) => row.textContent).toSorted(),
    ).toEqual(["Usage on 2026-05-02", "Usage on 2026-05-04"]);
  },
);

it("keeps the same calendar interactive while day totals are pending", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  focusDocument();
  const snapshot = cacheSnapshot("fresh");
  const daily = [dailyEntry("2026-05-02", 100), dailyEntry("2026-05-04", 900)];
  const result = {
    ...snapshot.result,
    totals: { ...snapshot.result.totals, totalTokens: 1000 },
    sessions: daily.map((day) => ({
      key: `agent:main:${day.date}`,
      usage: {
        ...day,
        activityDates: [day.date],
        dailyBreakdown: [{ ...day, tokens: day.totalTokens, cost: day.totalCost }],
      },
    })),
    aggregates: { ...snapshot.result.aggregates, costDaily: daily },
  };
  const unresolved = new Promise<never>(() => {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === "sessions.usage"
      ? Array.isArray(params?.selectedDays)
        ? unresolved
        : result
      : { providers: [] },
  );
  const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
  await preloadUsage(page);
  const bars = () => [...page.querySelectorAll<HTMLElement>(".daily-bar-wrapper")];
  const first = bars()[0]!;
  const last = bars().at(-1)!;
  first.click();
  await page.updateComplete;
  expect(page.querySelector(".usage-metric-badge")).toBeNull();
  expect(bars()).toContain(last);
  last.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await page.updateComplete;
  const days = request.mock.calls.findLast(([method]) => method === "sessions.usage")?.[1]
    ?.selectedDays;
  expect(days).toEqual(expect.arrayContaining(["2026-04-05", "2026-05-04"]));
  expect(Array.isArray(days) && days.length > 1).toBe(true);
});
