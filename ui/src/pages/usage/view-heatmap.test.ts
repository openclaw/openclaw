import { describe, expect, it } from "vitest";
import type { CostDailyEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { renderUsageHeatmap } from "./view-heatmap.tsx";
import { mountView } from "./view-render.test-support.ts";

function mountHeatmap(daily: CostDailyEntry[], start: string, end: string) {
  return mountView(() => renderUsageHeatmap(daily, start, end)).container;
}

describe("renderUsageHeatmap", () => {
  it("keeps short ranges at their natural cell width", () => {
    const container = mountHeatmap([dailyEntry("2026-08-01", 20)], "2026-08-01", "2026-08-01");

    expect(
      container
        .querySelector<SVGElement>(".usage-heatmap__svg")
        ?.style.getPropertyValue("--usage-heatmap-width"),
    ).toBe("44px");
    const month = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
    expect(container.querySelector(".usage-heatmap__month")?.textContent).toBe(
      month.format(new Date("2026-08-01T12:00:00Z")),
    );
    const cell = container.querySelector(".usage-heatmap__cell")!;
    expect([cell.getAttribute("x"), cell.getAttribute("y")]).toEqual(["30", "102"]);
  });

  it.each(["2025-07-11", "1970-01-01"])(
    "caps %s ranges to 364 trailing days in Sunday-first columns",
    (start) => {
      const container = mountHeatmap([dailyEntry("2026-07-09", 10)], start, "2026-07-09");
      expect(container.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
        "Token Activity",
      );
      const cells = [...container.querySelectorAll(".usage-heatmap__cell")];
      expect(cells).toHaveLength(364);
      const dateFormat = new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      expect(cells[0]?.getAttribute("data-tooltip")).toContain(
        dateFormat.format(new Date("2025-07-11T12:00:00Z")),
      );
      const position = (cell: Element | undefined) =>
        ["x", "y"].map((key) => cell?.getAttribute(key));
      expect(position(cells[0])).toEqual(["30", "88"]);
      expect(cells.at(-1)?.getAttribute("data-tooltip")).toContain("10 tokens");
      expect(cells.at(-1)?.getAttribute("data-tooltip")).toContain(
        dateFormat.format(new Date("2026-07-09T12:00:00Z")),
      );
      expect(position(cells.at(-1))).toEqual(["758", "74"]);
      const months = [...container.querySelectorAll(".usage-heatmap__month")];
      expect(months.length).toBeGreaterThanOrEqual(12);
      expect(months[0]?.getAttribute("x")).toBe("30");
      expect(months[0]?.textContent).not.toBe("");
    },
  );

  it("buckets zero activity and nonzero quartiles into levels 0 through 4", () => {
    const container = mountHeatmap(
      [0, 10, 20, 30, 40].map((tokens, index) => dailyEntry(`2026-07-0${index + 5}`, tokens)),
      "2026-07-05",
      "2026-07-09",
    );
    const cells = [...container.querySelectorAll(".usage-heatmap__cell")];
    expect(cells).toHaveLength(5);
    for (const [index, tokens] of [0, 10, 20, 30, 40].entries()) {
      expect(cells[index]?.classList.contains(`usage-heatmap__cell--l${index}`)).toBe(true);
      expect(cells[index]?.getAttribute("data-tooltip")).toContain(`${tokens} tokens`);
    }
  });

  it("keeps known tokens visible as a lower bound for interrupted responses", () => {
    const entry = dailyEntry("2026-07-09", 20);
    const container = mountHeatmap(
      [{ ...entry, usageReport: { state: "unavailable" } }],
      "2026-07-09",
      "2026-07-09",
    );
    const cell = container.querySelector(".usage-heatmap__svg .usage-heatmap__cell--l4")!;
    expect(cell.getAttribute("data-tooltip")).toContain("≥ 20 tokens");
    expect(cell.getAttribute("aria-label")).toBe(cell.getAttribute("data-tooltip"));
  });
});
