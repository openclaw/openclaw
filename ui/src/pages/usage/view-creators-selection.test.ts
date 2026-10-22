import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { selectUsageExport } from "./export-menu.test-support.ts";
import type { UsageSessionEntry } from "./types.ts";
import { mountView, texts } from "./view-render.test-support.ts";
import { projectUsageData, createUsageProps, usageSession } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

const costTotals = (cost: number) => ({
  ...createEmptyCostUsageTotals(),
  input: cost * 100,
  inputCost: cost,
  totalTokens: cost * 100,
  totalCost: cost,
});

function creatorSession(id: string, multiplier: number) {
  const daily = [
    { date: "2026-05-14", cost: multiplier },
    { date: "2026-05-15", cost: 9 * multiplier },
  ].map(({ date, cost }) => Object.assign(costTotals(cost), { date, tokens: cost * 100, cost }));
  return {
    ...usageSession(`agent:main:${id}`, "main", "fixture"),
    creatorKey: id,
    createdActor: { type: "human" as const, id, label: id },
    usage: {
      ...costTotals(10 * multiplier),
      firstActivity: Date.parse("2026-05-14T12:00:00Z"),
      activityDates: daily.map((day) => day.date),
      dailyBreakdown: daily,
    },
  };
}

function mountSessions(sessions: UsageSessionEntry[], limit: number, selectedDays?: string[]) {
  const base = createUsageProps();
  const projected = projectUsageData(sessions, selectedDays ? { selectedDays } : undefined);
  const onExportJson = vi.fn();
  const onExportCsv = vi.fn();
  const props = {
    ...base,
    data: { ...base.data, ...projected, sessions: projected.sessions.slice(0, limit) },
    filters: selectedDays ? { ...base.filters, endDate: "2026-05-15", selectedDays } : base.filters,
    callbacks: {
      ...base.callbacks,
      display: { ...base.callbacks.display, onExportJson, onExportCsv },
    },
  };
  return { ...mountView(() => renderUsage(props)), onExportJson, onExportCsv };
}

const creatorCells = (tokens: string, cost: string) => [tokens, cost, "1"];

it.each([
  {
    selectedDays: ["2026-05-14"],
    metrics: ["300", "$3.00", "2"],
    rows: [creatorCells("200", "$2.00"), creatorCells("100", "$1.00")],
  },
  {
    selectedDays: ["2026-05-14", "2026-05-15"],
    metrics: ["3.0K", "$30.00", "2"],
    rows: [creatorCells("2.0K", "$20.00"), creatorCells("1.0K", "$10.00")],
  },
])(
  "keeps creators beyond the visible session cap for $selectedDays",
  async ({ selectedDays, metrics, rows }) => {
    const sessions = [creatorSession("Alex", 1), creatorSession("Jordan", 2)];
    const { container, onExportJson } = mountSessions(sessions, 1, selectedDays);
    expect(container.querySelector(".usage-creators-table")?.textContent).toContain("Jordan");
    expect(
      [...container.querySelectorAll(".usage-creators-table tbody tr")].map((row) =>
        texts(row, "td"),
      ),
    ).toEqual(rows);
    expect(texts(container, ".usage-metric-badge strong", false)).toEqual(metrics);
    await selectUsageExport(container.querySelector(".usage-export-menu")!, "json");
    expect(onExportJson).toHaveBeenCalledWith();
  },
);

it("exports all matched sessions even when the current roster page is empty", async () => {
  const { container, onExportCsv } = mountSessions([creatorSession("Alex", 1)], 0);
  expect(container.querySelectorAll(".session-bar-row")).toHaveLength(0);
  expect(container.querySelectorAll(".usage-metric-badge strong")[2]?.textContent).toBe("1");
  const menu = container.querySelector(".usage-export-menu")!;
  expect(menu.querySelector('[data-value="sessions-csv"]')!.hasAttribute("disabled")).toBe(false);
  await selectUsageExport(menu, "sessions-csv");
  expect(onExportCsv).toHaveBeenCalledWith("sessions-csv");
});
