import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { projectUsageData, createUsageProps, usageSession } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

function creatorSession(id: string, multiplier: number) {
  const daily = [
    { date: "2026-05-14", cost: multiplier },
    { date: "2026-05-15", cost: 9 * multiplier },
  ].map(({ date, cost }) =>
    Object.assign(createEmptyCostUsageTotals(), {
      date,
      input: cost * 100,
      inputCost: cost,
      totalTokens: cost * 100,
      totalCost: cost,
      tokens: cost * 100,
      cost,
    }),
  );
  return {
    ...usageSession(`agent:main:${id}`, "main", "fixture"),
    creatorKey: id,
    createdActor: { type: "human" as const, id, label: id },
    usage: {
      ...createEmptyCostUsageTotals(),
      input: 1000 * multiplier,
      totalTokens: 1000 * multiplier,
      inputCost: 10 * multiplier,
      totalCost: 10 * multiplier,
      firstActivity: Date.parse("2026-05-14T12:00:00Z"),
      activityDates: daily.map((day) => day.date),
      dailyBreakdown: daily,
    },
  };
}

it.each([
  { selectedDays: ["2026-05-14"], tokens: "300", cost: "$3.00", costs: [1, 2] },
  {
    selectedDays: ["2026-05-14", "2026-05-15"],
    tokens: "3.0K",
    cost: "$30.00",
    costs: [10, 20],
  },
])(
  "keeps creators beyond the visible session cap for $selectedDays",
  ({ selectedDays, tokens, cost, costs }) => {
    const base = createUsageProps();
    const sessions = [creatorSession("Alex", 1), creatorSession("Jordan", 2)];
    const onExportJson = vi.fn();
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsage({
          ...base,
          data: {
            ...base.data,
            ...projectUsageData(sessions, { selectedDays }),
            sessions: projectUsageData(sessions, { selectedDays }).sessions.slice(0, 1),
          },
          filters: { ...base.filters, endDate: "2026-05-15", selectedDays },
          callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportJson } },
        }),
      { container },
    );
    flush();
    expect(container.querySelector(".usage-creators-table")?.textContent).toContain("Jordan");
    expect(container.querySelectorAll(".usage-creators-table tbody tr")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".usage-creators-table tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
      ),
    ).toEqual(
      costs
        .toReversed()
        .map((value) => [
          value < 10 ? String(value * 100) : `${value / 10}.0K`,
          `$${value.toFixed(2)}`,
          "1",
        ]),
    );
    expect(
      Array.from(
        container.querySelectorAll(".usage-metric-badge strong"),
        (node) => node.textContent,
      ),
    ).toEqual([tokens, cost, "2"]);
    container
      .querySelector(".usage-export-menu")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    expect(onExportJson).toHaveBeenCalledWith();
  },
);

it("exports all matched sessions even when the current roster page is empty", () => {
  const base = createUsageProps();
  const session = creatorSession("Alex", 1);
  const onExportCsv = vi.fn();
  const container = document.createElement("div");
  mountSolid(
    () =>
      renderUsage({
        ...base,
        data: { ...base.data, ...projectUsageData([session]), sessions: [] },
        callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportCsv } },
      }),
    { container },
  );
  flush();
  expect(container.querySelectorAll(".session-bar-row")).toHaveLength(0);
  expect(container.querySelectorAll(".usage-metric-badge strong")[2]?.textContent).toBe("1");
  const menu = container.querySelector(".usage-export-menu")!;
  expect(menu.querySelector('[value="sessions-csv"]')!.hasAttribute("disabled")).toBe(false);
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "sessions-csv" } } }));
  expect(onExportCsv).toHaveBeenCalledWith("sessions-csv");
});
