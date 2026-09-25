/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { CostDailyEntry } from "./types.ts";
import { renderUsageHeatmap } from "./view-heatmap.ts";

function dailyEntry(date: string, totalTokens: number): CostDailyEntry {
  return {
    date,
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderUsageHeatmap", () => {
  it("renders the selected activity range from usage cost data", () => {
    const container = document.createElement("div");
    render(
      renderUsageHeatmap(
        [dailyEntry("2026-07-08", 10), dailyEntry("2026-07-09", 20)],
        "2025-07-11",
        "2026-07-09",
      ),
      container,
    );

    expect(container.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
      "Token Activity",
    );
    expect(container.querySelectorAll(".usage-heatmap__cell")).toHaveLength(52 * 7);
    expect(
      container
        .querySelector(".usage-heatmap__svg .usage-heatmap__cell--l4")
        ?.getAttribute("data-tooltip"),
    ).toContain("20 tokens");
  });

  it("keeps short ranges at their natural cell width", () => {
    const container = document.createElement("div");
    render(
      renderUsageHeatmap([dailyEntry("2026-08-01", 20)], "2026-08-01", "2026-08-01"),
      container,
    );

    expect(
      container
        .querySelector<SVGElement>(".usage-heatmap__svg")
        ?.style.getPropertyValue("--usage-heatmap-width"),
    ).toBe("44px");
  });
});
