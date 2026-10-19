import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createUsageProps, projectUsageData, usageSession } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

it("shows lower-bound totals after interruption while keeping completed session usage exact", () => {
  const base = createUsageProps();
  const interrupted = usageSession("interrupted", "interrupted", "ollama", {
    totalTokens: 0,
    totalCost: 0,
    usageReport: { state: "unavailable" },
  });
  const completeTotals = {
    ...createEmptyCostUsageTotals(),
    totalTokens: 2624,
    totalCost: 0,
  };
  const completed = usageSession("completed", "completed", "ollama", completeTotals);
  const sessions = [interrupted, completed];
  const container = document.createElement("div");
  const [selection, setSelection] = createSignal<string[]>([]);
  const props = createUsageProps();
  mountSolid(
    () =>
      renderUsage({
        ...props,
        get data() {
          return { ...base.data, ...projectUsageData(sessions, { selectedSessions: selection() }) };
        },
        get filters() {
          return { ...base.filters, selectedSessions: selection() };
        },
      }),
    { container },
  );
  flush();

  expect(
    [...container.querySelectorAll(".usage-metric-badge strong")].map((node) => node.textContent),
  ).toEqual(["≥ 2.6K", "≥ $0.00", "2"]);
  // Analytics stay visible; a note explains the lower bound instead of hiding them.
  expect(container.querySelector(".usage-trend-section")).not.toBeNull();
  expect(container.querySelector('.usage-callout[role="note"]')?.textContent).toContain(
    "lower bound",
  );
  expect(container.querySelector('[title="interrupted"] .session-bar-value')?.textContent).toBe(
    "≥ 0",
  );
  expect(container.querySelector('[title="completed"] .session-bar-value')?.textContent).toBe(
    "2.6K",
  );

  expect(container.querySelector(".sessions-card-stats")?.textContent).toContain("≥ ");
  // Restored analytics mark partial sums and hide ratios built from partial counters.
  expect(container.querySelector(".cost-breakdown-total")?.textContent).toContain("≥ ");
  const summaryValue = (hint: string) =>
    container
      .querySelector(`#usage-summary-hint-${hint}`)
      ?.closest(".usage-summary-card")
      ?.querySelector(".usage-summary-value")
      ?.textContent?.trim();
  expect(summaryValue("cache-hit-rate")).toBe("—");
  expect(summaryValue("average-tokens")).toBe("—");
  expect(container.textContent).not.toContain("of cost");

  setSelection(["completed"]);
  flush();
  expect(
    [...container.querySelectorAll(".usage-metric-badge strong")].map((node) => node.textContent),
  ).toEqual(["2.6K", "$0.00", "1"]);
  expect(container.querySelector(".usage-trend-section")).not.toBeNull();
  expect(container.querySelector('.usage-callout[role="note"]')).toBeNull();
  // An exact selection shows exact sums and ratios again.
  expect(container.querySelector(".cost-breakdown-total")?.textContent).not.toContain("≥");
  expect(summaryValue("average-tokens")).not.toBe("—");
});

it("keeps the lower-bound note for full-session charts when only the selected day is complete", () => {
  const session = usageSession("mixed-days", "main", "ollama", {
    totalTokens: 100,
    usageReport: { state: "unavailable" },
  });
  session.usage!.activityDates = ["2026-05-14", "2026-05-15"];
  session.usage!.dailyBreakdown = [
    { ...createEmptyCostUsageTotals(), date: "2026-05-14", tokens: 100, cost: 0, totalTokens: 100 },
    {
      ...createEmptyCostUsageTotals(),
      date: "2026-05-15",
      tokens: 0,
      cost: 0,
      usageReport: { state: "unavailable" },
    },
  ];
  const base = createUsageProps();
  const selectedDays = ["2026-05-14"];
  const props = createUsageProps({
    data: { ...base.data, ...projectUsageData([session], { selectedDays }) },
    filters: { ...base.filters, selectedDays },
  });
  const container = document.createElement("div");
  mountSolid(() => renderUsage(props), { container });
  flush();
  // The selected day is complete, so its total is exact.
  expect(container.querySelector(".usage-metric-badge strong")?.textContent).toBe("100");
  expect(container.querySelector(".usage-trend-section")).not.toBeNull();
  expect(container.querySelector(".usage-mosaic")).not.toBeNull();
  // Full-session rollups still include the interrupted day.
  expect(container.querySelector('.usage-callout[role="note"]')?.textContent).toContain(
    "lower bound",
  );
});
