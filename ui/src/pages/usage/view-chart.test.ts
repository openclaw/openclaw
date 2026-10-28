import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildProviderSeries, type ProviderSeries } from "./provider-series.ts";
import type { CostDailyEntry, UsageProps } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { DailyChartCompact } from "./view-chart.tsx";
import { mountView, usageState } from "./view-render.test-support.ts";
import { renderUsage } from "./view.tsx";

afterEach(() => document.body.replaceChildren());

function renderDailyChart(
  daily: CostDailyEntry[],
  chartMode: "tokens" | "cost" = "cost",
  dailyChartMode: UsageProps["display"]["dailyChartMode"] = "total",
  providerSeries: ProviderSeries[] = [],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const onSelectDay = vi.fn<(day: string, shiftKey: boolean, orderedDays: string[]) => void>();
  mountSolid(
    () =>
      DailyChartCompact({
        dailyEntries: daily,
        selectedDays: [],
        chartMode,
        dailyChartMode,
        onDailyChartModeChange: () => {},
        providerSeries,
        onSelectDay,
        range: {
          startDate: daily[0]?.date ?? "2026-05-01",
          endDate: daily.at(-1)?.date ?? "2026-05-01",
          complete: true,
        },
      }),
    { container },
  );
  flush();
  return {
    container,
    onSelectDay,
    bars: Array.from(container.querySelectorAll<HTMLElement>(".daily-bar-wrapper")),
  };
}

describe("DailyChartCompact", () => {
  it("formats only visible axis labels while keeping every day accessible across ranges", () => {
    const dates = Array.from({ length: 180 }, (_, index) =>
      new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    );
    const [count, setCount] = createSignal(180);
    const { container } = mountSolid(() =>
      DailyChartCompact({
        get dailyEntries() {
          return dates.slice(0, count()).map((date) => dailyEntry(date, 100));
        },
        selectedDays: [],
        chartMode: "tokens",
        dailyChartMode: "total",
        onDailyChartModeChange: () => {},
        providerSeries: [],
        onSelectDay: () => {},
        get range() {
          return { startDate: dates[0]!, endDate: dates[count() - 1]!, complete: true };
        },
      }),
    );
    const bars = () => [...container.querySelectorAll(".daily-bar-wrapper")];
    const labels = () => [...container.querySelectorAll(".daily-bar-label")];
    flush();
    expect(bars()).toHaveLength(180);
    expect(bars().every((bar) => bar.getAttribute("aria-label")?.includes("100"))).toBe(true);
    expect(labels().filter((label) => label.textContent)).toHaveLength(7);
    expect(
      labels().filter((label) => !label.classList.contains("daily-bar-label--hidden")),
    ).toHaveLength(7);

    setCount(4);
    flush();
    expect(bars()).toHaveLength(4);
    expect(labels().every((label) => label.textContent)).toBe(true);
  });

  it("keeps day selection operable with mouse and keyboard", () => {
    const entry = dailyEntry("2026-05-04", 500, 0.2);
    const { usage, setFilters } = usageState(
      { startDate: entry.date, endDate: entry.date },
      (data) => ({ ...data, totals: entry, costDaily: [entry] }),
    );
    const onSelectDay = vi.fn((day: string, _shiftKey: boolean, _orderedDays: string[]) =>
      setFilters((current) => ({
        ...current,
        selectedDays: current.selectedDays.includes(day) ? [] : [day],
      })),
    );
    usage.callbacks.filters.onSelectDay = onSelectDay;
    const { container } = mountView(() => renderUsage(usage));
    const bar = expectDefined(
      container.querySelector<HTMLElement>(".daily-bar-wrapper"),
      "daily usage bar",
    );
    bar.focus();

    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);
    flush();
    expect(container.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(document.activeElement).toBe(bar);
    expect(bar.getAttribute("aria-pressed")).toBe("true");

    bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false, ["2026-05-04"]);
    flush();
    expect(container.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(document.activeElement).toBe(bar);
    expect(bar.getAttribute("aria-pressed")).toBe("false");

    const space = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
      shiftKey: true,
    });
    bar.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);
  });

  it.each([
    { costs: [1, 100], labels: ["$100", "$50", "$0"], stacked: false },
    { costs: [0.004, 0.008], labels: ["$0.010", "$0.005", "$0.000"], stacked: false },
    { costs: [0.00001], labels: ["$0.000010", "$0.000005", "$0.000000"], stacked: true },
    {
      costs: Array.from({ length: 15 }, (_, index) => index + 1),
      labels: ["$20", "$10", "$0"],
      stacked: false,
    },
  ])("scales cost bars and labels consistently for $costs", ({ costs, labels, stacked }) => {
    const daily = costs.map((cost, index) => ({
      ...dailyEntry(`2026-05-${String(index + 1).padStart(2, "0")}`, 1_000, cost),
      ...(stacked ? { inputCost: 0.000004, outputCost: 0.000006 } : {}),
    }));
    const { container, bars } = renderDailyChart(daily, "cost", stacked ? "by-type" : "total");
    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(labels);
    // The tallest day reaches the rounded scale maximum, never past it.
    const heights = bars.map((bar) =>
      Number.parseFloat(bar.querySelector<HTMLElement>(".daily-bar")?.style.height ?? ""),
    );
    expect(Math.max(...heights)).toBeLessThanOrEqual(100);
    expect(Math.max(...heights)).toBeGreaterThan(40);
    if (stacked) {
      bars[0]!.focus();
      flush();
      const tip = [...container.querySelectorAll(".daily-chart-tip span")].map(
        (entry) => entry.textContent,
      );
      expect(tip).toEqual(["Output$0.000006", "Input$0.000004"]);
    }
  });

  it.each([false, true])(
    "stacks each day by provider without claiming shares of incomplete totals (partial: %s)",
    (partial) => {
      const daily = [dailyEntry("2026-05-01", 400), dailyEntry("2026-05-02", 100)];
      if (partial) {
        daily[0]!.usageReport = { state: "unavailable" };
      }
      const series = buildProviderSeries([
        { date: "2026-05-01", provider: "openai", model: "a", tokens: 300, cost: 0, count: 1 },
        { date: "2026-05-01", provider: "anthropic", model: "b", tokens: 100, cost: 0, count: 1 },
        { date: "2026-05-02", provider: "anthropic", model: "b", tokens: 100, cost: 0, count: 1 },
      ]);
      const { container, bars } = renderDailyChart(daily, "tokens", "by-provider", series);

      const segments = (bar: HTMLElement) =>
        [...bar.querySelectorAll<HTMLElement>(".cost-segment")].map((segment) => ({
          grow: segment.style.flexGrow,
          background: segment.style.background,
        }));
      expect(segments(bars[0]!)).toEqual([
        { grow: "300", background: "var(--chart-series-1)" },
        { grow: "100", background: "var(--chart-series-2)" },
      ]);
      // A provider with no usage that day adds no empty segment.
      expect(segments(bars[1]!)).toEqual([{ grow: "100", background: "var(--chart-series-2)" }]);
      bars[0]!.focus();
      flush();
      expect(
        [...container.querySelectorAll(".daily-chart-tip span")].map((entry) => entry.textContent),
      ).toEqual(partial ? ["OpenAI≥ 300", "Anthropic≥ 100"] : ["OpenAI300", "Anthropic100"]);
      expect(
        [...container.querySelectorAll(".daily-chart-legend li")].map((item) =>
          item.textContent?.trim(),
        ),
      ).toEqual(partial ? ["OpenAI", "Anthropic"] : ["OpenAI60%", "Anthropic40%"]);
    },
  );

  it("retains provider segments and updates their values, colors and order across reports", () => {
    const date = "2026-05-01";
    const providers = (tokens: number[]) =>
      buildProviderSeries(
        tokens.map((value, index) => ({
          date,
          provider: `provider-${index}`,
          model: "model",
          tokens: value,
          cost: 0,
          count: 1,
        })),
      );
    const [series, setSeries] = createSignal(providers([300, 100]));
    const { container } = mountSolid(() =>
      DailyChartCompact({
        dailyEntries: [dailyEntry(date, 400)],
        selectedDays: [],
        chartMode: "tokens",
        dailyChartMode: "by-provider",
        onDailyChartModeChange: () => {},
        get providerSeries() {
          return series();
        },
        onSelectDay: () => {},
        range: { startDate: date, endDate: date, complete: true },
      }),
    );
    flush();
    const segments = () => [...container.querySelectorAll<HTMLElement>(".daily-bar .cost-segment")];
    const [first, second] = segments();
    expect(first?.style.flexGrow).toBe("300");
    expect(first?.style.background).toBe("var(--chart-series-1)");

    setSeries(providers([100, 300]));
    flush();
    const refreshed = segments();
    expect(refreshed).toHaveLength(2);
    expect(refreshed[0]).toBe(second);
    expect(refreshed[1]).toBe(first);
    expect(first?.style.flexGrow).toBe("100");
    expect(first?.style.background).toBe("var(--chart-series-2)");
    expect(second?.style.flexGrow).toBe("300");
    expect(second?.style.background).toBe("var(--chart-series-1)");
  });

  it("keeps usage without per-model rows in the by-provider day total", () => {
    const series = buildProviderSeries([
      { date: "2026-05-01", provider: "openai", model: "a", tokens: 100, cost: 0, count: 1 },
    ]);
    const daily = [dailyEntry("2026-05-01", 400), dailyEntry("2026-05-02", 200)];
    const { container, bars } = renderDailyChart(daily, "tokens", "by-provider", series);
    expect(bars.map((bar) => bar.querySelector<HTMLElement>(".daily-bar")?.style.height)).toEqual([
      "80%",
      "40%",
    ]);
    expect(
      [...container.querySelectorAll(".daily-chart-legend li")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["Other83%", "OpenAI17%"]);
  });

  it("renders a range without cost as zero", () => {
    const { container } = renderDailyChart([dailyEntry("2026-05-01", 10)], "cost");
    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map(
        (entry) => entry.textContent,
      ),
    ).toEqual(["$0.00", "$0.00", "$0.00"]);
  });

  it("shows no legend for the single total series", () => {
    const { container } = renderDailyChart([dailyEntry("2026-05-01", 1)], "tokens", "total");
    expect(container.querySelector(".daily-chart-legend")).toBeNull();
  });

  it("keeps a range preset focused while applying its dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const { usage, onDatesChange } = usageState({ timeZone: "utc" });
    const { container } = mountView(() => renderUsage(usage));
    try {
      const preset = [
        ...container.querySelectorAll<HTMLButtonElement>(".usage-presets button"),
      ].find((button) => button.textContent?.trim() === "7d")!;
      preset.focus();
      preset.click();
      flush();
      expect(onDatesChange.mock.calls.map(([patch]) => patch)).toEqual([
        { startDate: "2026-05-08" },
        { endDate: "2026-05-14" },
      ]);
      expect([...container.querySelectorAll(".usage-presets button")]).toContain(preset);
      expect(document.activeElement).toBe(preset);
      expect(preset.getAttribute("aria-pressed")).toBe("true");
    } finally {
      container.remove();
      vi.useRealTimers();
    }
  });
});
