/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { buildAggregatesFromSessions } from "./metrics.ts";
import { createUsageProps, usageSession } from "./view.test-support.ts";
import { renderUsage } from "./view.ts";

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
    const report = creatorSession("report", 3).usage;
    const byCreator = sessions.map((session) => ({
      key: session.creatorKey,
      actor: session.createdActor,
      totals: session.usage,
      sessionCount: 1,
      daily: session.usage.dailyBreakdown,
      sessionActivity: [{ dates: ["2026-05-14", "2026-05-15"], sessionCount: 1 }],
    }));
    const onExportJson = vi.fn();
    const container = document.createElement("div");
    render(
      renderUsage({
        ...base,
        data: {
          ...base.data,
          sessions: sessions.slice(0, 1),
          sessionsLimitReached: true,
          totals: report,
          costDaily: report.dailyBreakdown,
          aggregates: { ...buildAggregatesFromSessions(sessions), byCreator, sessionCount: 2 },
        },
        filters: { ...base.filters, endDate: "2026-05-15", selectedDays },
        callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportJson } },
      }),
      container,
    );
    expect(container.querySelector(".usage-creators-table")?.textContent).toContain("Jordan");
    expect(container.querySelectorAll(".usage-creators-table tbody tr")).toHaveLength(2);
    expect(
      Array.from(
        container.querySelectorAll(".usage-metric-badge strong"),
        (node) => node.textContent,
      ),
    ).toEqual([tokens, cost, "2"]);
    container
      .querySelector(".usage-export-menu")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    const exported = onExportJson.mock.calls[0]?.[0];
    expect(exported.aggregates.sessionCount).toBe(2);
    expect(exported.aggregates.byCreator).toEqual(
      expect.arrayContaining(
        ["Alex", "Jordan"].map((key, index) =>
          expect.objectContaining({
            key,
            totals: expect.objectContaining({ totalCost: costs[index] }),
            sessionCount: 1,
          }),
        ),
      ),
    );
    expect(exported.aggregates.byCreator).toHaveLength(2);
  },
);

it.each([
  { selectedDays: ["2026-05-14"], tokens: "100", cost: "$1.00" },
  { selectedDays: ["2026-05-15"], tokens: "900", cost: "$9.00" },
  { selectedDays: ["2026-05-14", "2026-05-15"], tokens: "1.0K", cost: "$10.00" },
])(
  "scopes creator amounts to selected calendar days: $selectedDays",
  ({ selectedDays, tokens, cost }) => {
    const base = createUsageProps();
    const daily = [
      { date: "2026-05-14", tokens: 100, cost: 1 },
      { date: "2026-05-15", tokens: 900, cost: 9 },
    ].map((day) =>
      Object.assign(createEmptyCostUsageTotals(), day, {
        input: day.tokens,
        totalTokens: day.tokens,
        inputCost: day.cost,
        totalCost: day.cost,
      }),
    );
    const session = usageSession("agent:main:multi-day", "main", "fixture");
    session.creatorKey = "creator-alex";
    session.createdActor = { type: "human", id: "alex", label: "Alex" };
    session.usage = {
      ...createEmptyCostUsageTotals(),
      input: 1000,
      totalTokens: 1000,
      inputCost: 10,
      totalCost: 10,
      firstActivity: Date.parse("2026-05-14T12:00:00Z"),
      activityDates: daily.map((day) => day.date),
      dailyBreakdown: daily,
    };
    const onExportJson = vi.fn();
    const container = document.createElement("div");
    render(
      renderUsage({
        ...base,
        data: {
          ...base.data,
          sessions: [session],
          totals: session.usage,
          costDaily: daily,
          aggregates: buildAggregatesFromSessions([session]),
        },
        filters: { ...base.filters, endDate: "2026-05-15", selectedDays },
        callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportJson } },
      }),
      container,
    );
    const cells = container.querySelectorAll(".usage-creators-table tbody td");
    expect(Array.from(cells, (cell) => cell.textContent?.trim())).toEqual([tokens, cost, "1"]);
    expect(container.querySelectorAll(".usage-metric-badge strong")[1]?.textContent).toBe(cost);
    container
      .querySelector(".usage-export-menu")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    const exported = onExportJson.mock.calls[0]?.[0];
    expect(exported.aggregates.byCreator[0].totals).toEqual(exported.totals);
  },
);

it("disables session-row exports without hiding complete creator totals beyond the loaded page", () => {
  const base = createUsageProps();
  const totals = {
    ...createEmptyCostUsageTotals(),
    input: 100,
    totalTokens: 100,
    inputCost: 1,
    totalCost: 1,
  };
  const sessions = ["2026-05-14", "2026-05-15"].map((date, index) => ({
    key: `session-${index}`,
    creatorKey: `creator-${index}`,
    createdActor: { type: "human" as const, id: `person-${index}`, label: `Person ${index}` },
    usage: {
      ...totals,
      firstActivity: Date.parse(`${date}T12:00:00Z`),
      activityDates: [date],
      dailyBreakdown: [{ ...totals, date, tokens: 100, cost: 1 }],
    },
  }));
  const onExportJson = vi.fn();
  const container = document.createElement("div");
  render(
    renderUsage({
      ...base,
      data: {
        ...base.data,
        sessions: sessions.slice(0, 1),
        sessionsLimitReached: true,
        totals: { ...totals, input: 200, totalTokens: 200, inputCost: 2, totalCost: 2 },
        costDaily: sessions.flatMap((session) => session.usage.dailyBreakdown),
        aggregates: buildAggregatesFromSessions(sessions),
      },
      filters: { ...base.filters, endDate: "2026-05-15", selectedDays: ["2026-05-15"] },
      callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportJson } },
    }),
    container,
  );

  expect(container.querySelectorAll(".session-bar-row")).toHaveLength(0);
  expect(container.querySelectorAll(".usage-metric-badge strong")[2]?.textContent).toBe("1");
  const menu = container.querySelector(".usage-export-menu")!;
  expect(menu.querySelector('[value="sessions-csv"]')!.hasAttribute("disabled")).toBe(true);
  expect(menu.querySelector('[value="json"]')!.hasAttribute("disabled")).toBe(false);
  menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
  expect(onExportJson).toHaveBeenCalledWith(
    expect.objectContaining({
      sessions: [],
      totals: expect.objectContaining({ totalTokens: 100, totalCost: 1 }),
      aggregates: expect.objectContaining({
        sessionCount: 1,
        byCreator: [expect.objectContaining({ key: "creator-1", sessionCount: 1 })],
      }),
    }),
  );
});
