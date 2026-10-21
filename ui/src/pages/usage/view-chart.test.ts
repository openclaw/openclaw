import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { CostDailyEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { DailyChartCompact } from "./view-chart.tsx";
import { mountView, texts, usageState } from "./view-render.test-support.ts";
import { renderUsage } from "./view.tsx";

afterEach(() => vi.useRealTimers());

function renderDailyChart(daily: CostDailyEntry[], stacked: boolean) {
  return mountView(() =>
    DailyChartCompact({
      dailyEntries: daily,
      selectedDays: [],
      chartMode: "cost",
      dailyChartMode: stacked ? "by-type" : "total",
      onDailyChartModeChange: () => {},
      onSelectDay: () => {},
      range: {
        startDate: daily[0]?.date ?? "2026-05-01",
        endDate: daily.at(-1)?.date ?? "2026-05-01",
        complete: true,
      },
    }),
  ).container;
}

describe("DailyChartCompact", () => {
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
    const expectSelection = (pressed: string) => {
      flush();
      expect(container.querySelector(".daily-bar-wrapper")).toBe(bar);
      expect(document.activeElement).toBe(bar);
      expect(bar.getAttribute("aria-pressed")).toBe(pressed);
    };

    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);
    expectSelection("true");

    bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false, ["2026-05-04"]);
    expectSelection("false");

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
    { costs: [1, 100], labels: ["$100.00", "$25.00", "$0.00"], stacked: false, badge: "√" },
    { costs: [0.004, 0.008], labels: ["$0.0080", "$0.0040", "$0.00"], stacked: false, badge: null },
    { costs: [0.00001], labels: ["$0.000010", "$0.000005", "$0.00"], stacked: true, badge: null },
    {
      costs: Array.from({ length: 15 }, (_, index) => index + 1),
      labels: ["$15.00", "$7.50", "$0.00"],
      stacked: false,
      badge: null,
    },
  ])("scales cost bars and labels consistently for $costs", ({ costs, labels, stacked, badge }) => {
    const daily = costs.map((cost, index) => ({
      ...dailyEntry(`2026-05-${String(index + 1).padStart(2, "0")}`, 1_000, cost),
      ...(stacked ? { inputCost: 0.000004, outputCost: 0.000006 } : {}),
    }));
    const container = renderDailyChart(daily, stacked);
    expect(texts(container, ".daily-chart-scale span")).toEqual(labels);
    const scaleBadge = container.querySelector(".daily-chart-scale-badge");
    if (badge === null) {
      expect(scaleBadge).toBeNull();
    } else {
      expect(scaleBadge?.textContent?.trim()).toBe(badge);
    }
    if (stacked) {
      expect(container.querySelector<HTMLElement>(".daily-bar")?.style.height).toBe("200px");
      expect(container.querySelector(".daily-bar-total")?.textContent?.trim()).toBe("$0.000010");
      const tooltip = container.querySelector<HTMLElement & { content: string }>(
        "openclaw-tooltip",
      );
      expect(tooltip?.content).toContain("$0.000010");
      expect(tooltip?.content).toContain("Output $0.000006");
      expect(tooltip?.content).toContain("Input $0.000004");
    }
    expect(container.querySelectorAll(".daily-bar-total--placeholder")).toHaveLength(
      costs.length === 15 ? 15 : 0,
    );
  });
  it("keeps a range preset focused while applying its dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const { usage, onDatesChange } = usageState({ timeZone: "utc" });
    const { container } = mountView(() => renderUsage(usage));
    const preset = [...container.querySelectorAll<HTMLButtonElement>(".usage-presets button")].find(
      (button) => button.textContent?.trim() === "7d",
    )!;
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
  });
});
