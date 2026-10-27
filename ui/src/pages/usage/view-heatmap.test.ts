import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { CostDailyEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { UsageHeatmap } from "./view-heatmap.tsx";
import { mountView } from "./view-render.test-support.ts";

function mountHeatmap(daily: CostDailyEntry[], start: string, end: string) {
  return mountView(() => UsageHeatmap({ daily, rangeStartDate: start, rangeEndDate: end }))
    .container;
}

describe("UsageHeatmap", () => {
  it("leaves short ranges to the daily chart", () => {
    const container = mountHeatmap([dailyEntry("2026-08-01", 20)], "2026-08-01", "2026-08-01");
    expect(container.querySelector(".usage-heatmap__svg")).toBeNull();
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
      "2026-05-08",
      "2026-07-09",
    );
    const cells = [...container.querySelectorAll(".usage-heatmap__cell")];
    expect(cells).toHaveLength(63);
    const fixtureDays = cells.slice(-5);
    for (const [index, tokens] of [0, 10, 20, 30, 40].entries()) {
      expect(fixtureDays[index]?.classList.contains(`usage-heatmap__cell--l${index}`)).toBe(true);
      expect(fixtureDays[index]?.getAttribute("data-tooltip")).toContain(`${tokens} tokens`);
    }
  });

  it("keeps known tokens visible as a lower bound for interrupted responses", () => {
    const entry = dailyEntry("2026-07-09", 20);
    const container = mountHeatmap(
      [{ ...entry, usageReport: { state: "unavailable" } }],
      "2026-05-08",
      "2026-07-09",
    );
    const cell = container.querySelector(".usage-heatmap__svg .usage-heatmap__cell--l4")!;
    expect(cell.getAttribute("data-tooltip")).toContain("≥ 20 tokens");
    expect(cell.getAttribute("aria-label")).toBe(cell.getAttribute("data-tooltip"));
  });

  it("retains refreshed dates and moves overlapping cells when the visible range changes", () => {
    const [state, setState] = createSignal({
      daily: [dailyEntry("2026-07-09", 20)],
      start: "2026-05-08",
      end: "2026-07-09",
    });
    const { container } = mountView(() =>
      UsageHeatmap({
        get daily() {
          return state().daily;
        },
        get rangeStartDate() {
          return state().start;
        },
        get rangeEndDate() {
          return state().end;
        },
      }),
    );
    const svg = container.querySelector(".usage-heatmap__svg");
    const cells = () => [...container.querySelectorAll(".usage-heatmap__cell")];
    const initial = cells();
    expect(initial).toHaveLength(63);
    const last = initial.at(-1)!;
    const first = initial[0]!;
    const originalX = Number(last.getAttribute("x"));
    expect(last.classList.contains("usage-heatmap__cell--l4")).toBe(true);

    setState((current) => ({
      ...current,
      daily: [
        dailyEntry("2026-07-08", 10),
        { ...dailyEntry("2026-07-09", 0), usageReport: { state: "unavailable" } },
      ],
    }));
    flush();
    expect(container.querySelector(".usage-heatmap__svg")).toBe(svg);
    expect(cells()).toHaveLength(initial.length);
    for (const [index, cell] of cells().entries()) {
      expect(cell).toBe(initial[index]);
    }
    expect(last.classList.contains("usage-heatmap__cell--l0")).toBe(true);
    expect(last.getAttribute("data-tooltip")).toContain("≥ 0 tokens");
    expect(last.getAttribute("aria-label")).toBe(last.getAttribute("data-tooltip"));

    setState((current) => ({ ...current, start: "2026-05-15", end: "2026-07-16" }));
    flush();
    expect(container.querySelector(".usage-heatmap__svg")).toBe(svg);
    expect(cells()).toHaveLength(63);
    expect(cells().at(-8)).toBe(last);
    expect(cells()).not.toContain(first);
    expect(Number(last.getAttribute("x"))).toBe(originalX - 14);
    expect(cells().at(-1)?.getAttribute("data-tooltip")).toContain(
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date("2026-07-16T12:00:00Z")),
    );

    setState((current) => ({ ...current, start: "2026-05-16" }));
    flush();
    expect(container.querySelector(".usage-heatmap__svg")).toBeNull();
    setState((current) => ({ ...current, start: "2026-05-15" }));
    flush();
    expect(cells()).toHaveLength(63);
    setState((current) => ({ ...current, daily: [] }));
    flush();
    expect(container.querySelector(".usage-heatmap__svg")).toBeNull();
  });

  it("updates localized labels without replacing the SVG or its cells", async () => {
    const restoreI18n = captureI18nStateForTesting();
    try {
      await i18n.setLocale("en");
      const container = mountHeatmap(
        [{ ...dailyEntry("2026-07-09", 1234), usageReport: { state: "unavailable" } }],
        "2026-05-08",
        "2026-07-09",
      );
      const svg = container.querySelector(".usage-heatmap__svg");
      const cells = [...container.querySelectorAll(".usage-heatmap__cell")];
      const cell = cells.at(-1)!;
      const englishTooltip = cell.getAttribute("data-tooltip");
      const dateLabel = englishTooltip?.split(" · ")[0];
      const hostFormattedTokens = new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 0,
      }).format(1234);
      const labels = () => {
        expect(container.querySelector(".usage-heatmap__svg")).toBe(svg);
        const current = [...container.querySelectorAll(".usage-heatmap__cell")];
        expect(current).toHaveLength(cells.length);
        for (const [index, currentCell] of current.entries()) {
          expect(currentCell).toBe(cells[index]);
        }
        expect(svg?.getAttribute("aria-label")).toBe(i18n.t("usage.heatmap.title"));
        expect(container.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
          i18n.t("usage.heatmap.title"),
        );
        expect(container.querySelector(".usage-heatmap__legend")?.textContent).toContain(
          i18n.t("usage.heatmap.less"),
        );
        expect(container.querySelector(".usage-heatmap__legend")?.textContent).toContain(
          i18n.t("usage.heatmap.more"),
        );
        expect(cell.getAttribute("data-tooltip")).toBe(
          `${dateLabel} · ${i18n.t("usage.heatmap.cellTokens", {
            tokens: i18n.t("usage.common.atLeast", { value: hostFormattedTokens }),
          })}`,
        );
        expect(cell.getAttribute("aria-label")).toBe(cell.getAttribute("data-tooltip"));
      };
      labels();
      await i18n.setLocale("de");
      flush();
      labels();
      expect(cell.getAttribute("data-tooltip")).not.toBe(englishTooltip);
      await i18n.setLocale("en");
      flush();
      labels();
      expect(cell.getAttribute("data-tooltip")).toBe(englishTooltip);
    } finally {
      await restoreI18n();
    }
  });
});
