import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { CostDailyEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { renderUsageHeatmap } from "./view-heatmap.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

function mountHeatmap(daily: CostDailyEntry[], start: string, end: string) {
  const { container } = mountSolid(() => renderUsageHeatmap(daily, start, end));
  flush();
  return container;
}

describe("renderUsageHeatmap", () => {
  it("renders the selected activity range from usage cost data", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsageHeatmap(
          [dailyEntry("2026-07-08", 10), dailyEntry("2026-07-09", 20)],
          "2025-07-11",
          "2026-07-09",
        ),
      { container },
    );
    flush();

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
    mountSolid(
      () => renderUsageHeatmap([dailyEntry("2026-08-01", 20)], "2026-08-01", "2026-08-01"),
      { container },
    );
    flush();

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
    expect(cell.getAttribute("x")).toBe("30");
    expect(cell.getAttribute("y")).toBe("102");
  });

  it.each(["2025-07-11", "1970-01-01"])(
    "caps %s ranges to 364 trailing days in Sunday-first columns",
    (start) => {
      const container = mountHeatmap([dailyEntry("2026-07-09", 10)], start, "2026-07-09");
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
      expect(cells[0]?.getAttribute("x")).toBe("30");
      expect(cells[0]?.getAttribute("y")).toBe("88");
      expect(cells.at(-1)?.getAttribute("data-tooltip")).toContain("10 tokens");
      expect(cells.at(-1)?.getAttribute("data-tooltip")).toContain(
        dateFormat.format(new Date("2026-07-09T12:00:00Z")),
      );
      expect(cells.at(-1)?.getAttribute("x")).toBe("758");
      expect(cells.at(-1)?.getAttribute("y")).toBe("74");
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
