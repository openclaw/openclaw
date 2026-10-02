/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostDailyEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { renderDailyChartCompact } from "./view-chart.ts";

afterEach(() => document.body.replaceChildren());

function renderDailyChart(
  daily: CostDailyEntry[],
  onSelectDay = vi.fn<(day: string, shiftKey: boolean, orderedDays: string[]) => void>(),
) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDailyChartCompact(daily, [], "tokens", "total", () => {}, onSelectDay, {
      startDate: daily[0]?.date ?? "2026-05-01",
      endDate: daily.at(-1)?.date ?? "2026-05-01",
      complete: true,
    }),
    container,
  );
  return {
    container,
    onSelectDay,
    bars: Array.from(container.querySelectorAll<HTMLElement>(".daily-bar-wrapper")),
  };
}

describe("renderDailyChartCompact", () => {
  it.each([true, false])(
    "keeps sparse historical dates ordered without inventing incomplete buckets (complete: %s)",
    (complete) => {
      const container = document.createElement("div");
      render(
        renderDailyChartCompact(
          [dailyEntry("2026-05-04", 900), dailyEntry("2026-05-02", 100)],
          [],
          "tokens",
          "by-type",
          () => {},
          () => {},
          { startDate: "2026-05-01", endDate: "2026-05-04", complete },
        ),
        container,
      );
      const bars = [...container.querySelectorAll(".daily-bar-wrapper")];
      expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual(
        complete
          ? [
              "May 1, 2026: 0 tokens, $0.00",
              "May 2, 2026: 100 tokens, $0.00",
              "May 3, 2026: 0 tokens, $0.00",
              "May 4, 2026: 900 tokens, $0.00",
            ]
          : ["May 2, 2026: 100 tokens, $0.00", "May 4, 2026: 900 tokens, $0.00"],
      );
      expect(container.querySelectorAll(".daily-bar--empty")).toHaveLength(complete ? 2 : 0);
      expect(container.querySelector(".daily-chart-range")?.textContent).toContain("May 1, 2026");
    },
  );
  it("keeps day selection operable with mouse and keyboard", () => {
    const { bars, onSelectDay } = renderDailyChart([dailyEntry("2026-05-04", 500, 0.2)]);
    const bar = expectDefined(bars[0], "daily usage bar");

    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);

    bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false, ["2026-05-04"]);

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

  it("labels the chart scale with the selected metric", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 1), dailyEntry("2026-05-04", 1_000, 2)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
        { startDate: "2026-05-03", endDate: "2026-05-04", complete: true },
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map(
        (entry) => entry.textContent,
      ),
    ).toEqual(["$2.00", "$1.00", "$0.00"]);
    expect(container.querySelector(".daily-chart-scale-badge")).toBeNull();
  });

  it("labels the true midpoint of a compressed chart scale", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 1), dailyEntry("2026-05-04", 1_000, 100)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
        { startDate: "2026-05-03", endDate: "2026-05-04", complete: true },
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$100.00", "$25.00", "$0.00"]);
    expect(container.querySelector(".daily-chart-scale-badge")?.textContent?.trim()).toBe("√");
  });

  it("preserves sub-cent values in chart scale labels", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 0.004), dailyEntry("2026-05-04", 1_000, 0.008)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
        { startDate: "2026-05-03", endDate: "2026-05-04", complete: true },
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$0.0080", "$0.0040", "$0.00"]);
  });

  it("normalizes a nonzero micro-cost bar to the labeled maximum", () => {
    const container = document.createElement("div");
    const microCostDay = {
      ...dailyEntry("2026-05-04", 1_000, 0.00001),
      inputCost: 0.000004,
      outputCost: 0.000006,
    };
    render(
      renderDailyChartCompact(
        [microCostDay],
        [],
        "cost",
        "by-type",
        () => {},
        () => {},
        { startDate: "2026-05-04", endDate: "2026-05-04", complete: true },
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$0.000010", "$0.000005", "$0.00"]);
    expect(container.querySelector<HTMLElement>(".daily-bar")?.style.height).toBe("200px");
    expect(container.querySelector(".daily-bar-total")?.textContent?.trim()).toBe("$0.000010");
    const tooltip = container.querySelector<HTMLElement & { content: string }>("openclaw-tooltip");
    expect(tooltip?.content).toContain("$0.000010");
    expect(tooltip?.content).toContain("Output $0.000006");
    expect(tooltip?.content).toContain("Input $0.000004");
    expect(container.querySelector(".daily-chart-scale-badge")).toBeNull();
  });

  it("reserves the totals row when dense ranges hide bar totals", () => {
    const container = document.createElement("div");
    const daily = Array.from({ length: 15 }, (_, index) =>
      dailyEntry(`2026-05-${String(index + 1).padStart(2, "0")}`, 1_000, index + 1),
    );
    render(
      renderDailyChartCompact(
        daily,
        [],
        "cost",
        "total",
        () => {},
        () => {},
        { startDate: "2026-05-01", endDate: "2026-05-15", complete: true },
      ),
      container,
    );

    expect(container.querySelectorAll(".daily-bar-total--placeholder")).toHaveLength(15);
  });
});
