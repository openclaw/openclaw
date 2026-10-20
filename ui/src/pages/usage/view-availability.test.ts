import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageProps, UsageSessionEntry } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { createUsageProps, projectUsageData, usageSession } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

function mountUsage(sessions: UsageSessionEntry[], filters: () => Partial<UsageProps["filters"]>) {
  const base = createUsageProps();
  const { container } = mountSolid(() =>
    renderUsage({
      ...base,
      get data() {
        return { ...base.data, ...projectUsageData(sessions, filters()) };
      },
      get filters() {
        return { ...base.filters, ...filters() };
      },
    }),
  );
  flush();
  return {
    container,
    query: (selector: string) => container.querySelector(selector),
    text: (selector: string) => container.querySelector(selector)?.textContent,
    badges: () =>
      [...container.querySelectorAll(".usage-metric-badge strong")].map((node) => node.textContent),
    summary: (hint: string) =>
      container
        .querySelector(`#usage-summary-hint-${hint}`)
        ?.closest(".usage-summary-card")
        ?.querySelector(".usage-summary-value")
        ?.textContent?.trim(),
  };
}

it("shows lower-bound totals after interruption while keeping completed session usage exact", () => {
  const interrupted = usageSession("interrupted", "interrupted", "ollama", {
    totalTokens: 0,
    totalCost: 0,
    usageReport: { state: "unavailable" },
  });
  const completed = usageSession("completed", "completed", "ollama", {
    ...createEmptyCostUsageTotals(),
    totalTokens: 2624,
    totalCost: 0,
  });
  const [selection, setSelection] = createSignal<string[]>([]);
  const { container, query, text, badges, summary } = mountUsage([interrupted, completed], () => ({
    selectedSessions: selection(),
  }));
  expect(badges()).toEqual(["≥ 2.6K", "≥ $0.00", "2"]);
  expect(query(".usage-trend-section")).not.toBeNull();
  expect(text('.usage-callout[role="note"]')).toContain("lower bound");
  expect(text('[title="interrupted"] .session-bar-value')).toBe("≥ 0");
  expect(text('[title="completed"] .session-bar-value')).toBe("2.6K");
  expect(text(".sessions-card-stats")).toContain("≥ ");
  expect(text(".cost-breakdown-total")).toContain("≥ ");
  expect(summary("cache-hit-rate")).toBe("—");
  expect(summary("average-tokens")).toBe("—");
  expect(container.textContent).not.toContain("of cost");

  setSelection(["completed"]);
  flush();
  expect(badges()).toEqual(["2.6K", "$0.00", "1"]);
  expect(query(".usage-trend-section")).not.toBeNull();
  expect(query('.usage-callout[role="note"]')).toBeNull();
  expect(text(".cost-breakdown-total")).not.toContain("≥");
  expect(summary("average-tokens")).not.toBe("—");
});

it("keeps the lower-bound note for full-session charts when only the selected day is complete", () => {
  const session = usageSession("mixed-days", "main", "ollama", {
    totalTokens: 100,
    usageReport: { state: "unavailable" },
  });
  session.usage!.activityDates = ["2026-05-14", "2026-05-15"];
  session.usage!.dailyBreakdown = [
    { ...dailyEntry("2026-05-14", 100), tokens: 100, cost: 0 },
    { ...dailyEntry("2026-05-15", 0), tokens: 0, cost: 0, usageReport: { state: "unavailable" } },
  ];
  const { query, text } = mountUsage([session], () => ({ selectedDays: ["2026-05-14"] }));
  expect(text(".usage-metric-badge strong")).toBe("100");
  expect(query(".usage-trend-section")).not.toBeNull();
  expect(query(".usage-mosaic")).not.toBeNull();
  expect(text('.usage-callout[role="note"]')).toContain("lower bound");
});
