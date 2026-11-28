/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  buildUsageModelCohortReport,
  prepareUsageModelCohorts,
  selectUsageModelCohorts,
} from "../../../../src/shared/usage-model-cohorts.js";
import {
  buildUsageOverview,
  compactUsageOverviewSession,
} from "../../../../src/shared/usage-overview.js";
import * as downloads from "../../lib/download.ts";
import * as toasts from "../../lib/toast.ts";
import { selectUsageExport } from "./export-menu.test-support.ts";
import type { UsageJsonExport } from "./types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  loadUsagePage,
  showRecentSessions,
  queryUsagePage,
  selectUsageSession,
  settleUsagePage,
  usageCalls,
} from "./usage-page.test-support.ts";
import { openUsageFilter, texts } from "./view-render.test-support.ts";
import { buildAggregatesFromSessions, usageTotals } from "./view.test-support.ts";

afterEach(cleanupUsagePageTest);
const sortedKeys = (labels: string[]) =>
  labels.map((label) => `agent:main:${label}`).toSorted((a, b) => a.localeCompare(b));

// The export owner tests the format matrix; exercise each menu action across distinct UI scopes.
it.each<
  [string, string[], string, string[], number, "sessions-csv" | "json" | "daily-csv", boolean?]
>([
  ["multiple selections", ["first", "second"], "", ["first", "second"], 400, "sessions-csv"],
  [
    "selection intersected with a query",
    ["first", "second"],
    "provider:openai",
    ["first"],
    100,
    "json",
  ],
  ["query without a selection", [], "provider:openai", ["first", "third"], 300, "daily-csv"],
  ["selection excluded by a query", ["second"], "provider:openai", [], 0, "sessions-csv"],
  [
    "quoted label retained while selecting a provider",
    [],
    '"label:Team Planning"',
    ["first"],
    100,
    "json",
    true,
  ],
])(
  "exports the displayed session scope: %s",
  async (_name, selected, query, expected, tokens, format, menuProvider) => {
    const snapshot = cacheSnapshot("fresh");
    const sessions = ["first", "second", "third"].map((label, index) => {
      const totalTokens = [100, 300, 200][index]!;
      const totals = {
        ...snapshot.result.totals,
        input: totalTokens,
        totalTokens,
        totalCost: totalTokens / 100,
        inputCost: totalTokens / 100,
      };
      return {
        key: `agent:main:${label}`,
        label: menuProvider
          ? ["Team Planning", "Research Review", "Team Quarterly Planning"][index]!
          : label,
        agentId: "main",
        sessionId: `${label}-instance`,
        modelProvider: index === 1 ? "anthropic" : "openai",
        updatedAt: Date.parse("2026-08-07T12:00:00Z") + 3 - index,
        hasContextWeight: true,
        usage: {
          ...totals,
          firstActivity: Date.parse("2026-08-07T12:00:00Z"),
          dailyBreakdown: [
            { ...totals, date: "2026-08-07", tokens: totalTokens, cost: totalTokens / 100 },
          ],
        },
      };
    });
    const result = {
      ...snapshot.result,
      sessions,
      aggregates: buildAggregatesFromSessions(sessions),
    };
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        return params?.includeContextWeight
          ? {
              ...result,
              sessions: sessions.map((session) =>
                Object.assign({}, session, {
                  contextWeight: contextWeight(session.label),
                }),
              ),
            }
          : result;
      }
      return { providers: [], points: [], logs: [] };
    });
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const { page } = await loadUsagePage(request);
    await showRecentSessions(page);
    // Match the fixture range so each export interaction renders only its populated day.
    page.read().callbacks.filters.onDatesChange({
      startDate: snapshot.result.startDate,
      endDate: snapshot.result.endDate,
    });
    await page.refresh();
    await page.updateComplete;
    for (const [index, label] of selected.entries()) {
      page
        .querySelector<HTMLButtonElement>(`.session-bar-selection[aria-label="${label}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
      await settleUsagePage(page);
    }
    if (query) {
      await queryUsagePage(page, query);
    }
    if (menuProvider) {
      expect(texts(page.element, ".session-bar-title")).toEqual(["Team Planning"]);
      const { surface } = openUsageFilter(page, "Provider");
      await vi.waitFor(() =>
        expect(
          surface.querySelector('[role="menuitemcheckbox"][aria-label="openai"]'),
        ).not.toBeNull(),
      );
      surface
        .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"][aria-label="openai"]')!
        .click();
      await vi.waitFor(() =>
        expect(usageCalls(request).at(-1)?.[1]).toMatchObject({
          query: page
            .querySelector<HTMLInputElement>(".usage-filter-menu__query input")!
            .value.trim(),
        }),
      );
      await settleUsagePage(page);
      page.querySelector<HTMLButtonElement>(".usage-filter-menu__trigger")!.click();
      expect
        .soft(page.querySelector<HTMLInputElement>(".usage-filter-menu__query input")!.value)
        .toBe(`${query} provider:openai `);
      expect.soft(texts(page.element, ".usage-metric-badge strong")).toEqual(["100", "$1.00", "1"]);
    }
    // Selection narrows accounting and exports, not the roster available for comparison.
    expect(
      new Set(
        [...page.querySelectorAll(".session-bar-row")].map((row) => row.getAttribute("title")),
      ),
    ).toEqual(
      new Set(
        sortedKeys(
          menuProvider ? expected : query ? ["first", "third"] : ["first", "second", "third"],
        ),
      ),
    );
    const menu = page.querySelector(".usage-export-menu")!;
    for (const value of ["sessions-csv", "json"]) {
      expect(menu.querySelector(`[data-value="${value}"]`)!.hasAttribute("disabled")).toBe(
        expected.length === 0,
      );
    }
    if (expected.length === 0) {
      expect(download).not.toHaveBeenCalled();
      return;
    }
    const before = usageCalls(request).length;
    await selectUsageExport(menu, format);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const sent = usageCalls(request)
      .slice(before)
      .find(([, params]) =>
        format === "daily-csv"
          ? params?.projection === "overview"
          : params?.limit === Number.MAX_SAFE_INTEGER,
      )?.[1];
    expect(sent).toMatchObject(
      format === "daily-csv"
        ? { projection: "overview", limit: 50 }
        : { limit: Number.MAX_SAFE_INTEGER, includeContextWeight: format === "json" },
    );
    if (format !== "daily-csv") {
      expect(sent).not.toHaveProperty("projection");
    }
    const keys = sortedKeys(expected);
    if (format !== "json") {
      const csv = download.mock.calls.find(([filename]) => filename.endsWith(".csv"))![1];
      const [header, ...rows] = csv.split("\n").map((row) => row.split(","));
      expect
        .soft(rows.map(([key]) => key).toSorted((a, b) => a!.localeCompare(b!)))
        .toEqual(format === "sessions-csv" ? keys : ["2026-08-07"]);
      expect
        .soft(rows.reduce((sum, row) => sum + Number(row[header!.indexOf("totalTokens")]), 0))
        .toBe(tokens);
      return;
    }
    const payload = JSON.parse(
      download.mock.calls.find(([filename]) => filename.endsWith(".json"))![1],
    ) as UsageJsonExport;
    expect
      .soft(payload.sessions.map((session) => session.key).toSorted((a, b) => a.localeCompare(b)))
      .toEqual(keys);
    expect([
      payload.totals?.totalTokens,
      payload.daily.reduce((sum, day) => sum + day.totalTokens, 0),
      payload.sessions.reduce((sum, session) => sum + (session.usage?.totalTokens ?? 0), 0),
    ]).toEqual([tokens, tokens, tokens]);
    for (const session of payload.sessions) {
      expect(session.contextWeight).toEqual(contextWeight(session.label!));
    }
  },
);

it.each([false, true])(
  "requires a refresh before exporting a replaced physical session (selected: %s)",
  async (selected) => {
    const { result } = cacheSnapshot("fresh");
    const key = "agent:main:reused";
    let sessionId = "first-instance";
    const request = async (method: string) =>
      method === "sessions.usage"
        ? {
            ...result,
            sessions: [
              {
                key,
                agentId: "main",
                sessionId,
                label: "Notebook",
                usage: result.totals,
                contextWeight: contextWeight(sessionId),
              },
            ],
          }
        : { providers: [], points: [], logs: [] };
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
    const { page } = await loadUsagePage(request);
    await showRecentSessions(page);
    if (selected) {
      selectUsageSession(page);
      await settleUsagePage(page);
    }
    expect(page.read().data.sessions[0]?.sessionId).toBe("first-instance");
    const exportJson = () => selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
    sessionId = "replacement-instance";
    await exportJson();
    await settleUsagePage(page);
    expect(download).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Refresh usage and try again") }),
    );

    await page.refresh();
    await settleUsagePage(page);
    expect(page.read().data.sessions[0]?.sessionId).toBe(sessionId);
    await exportJson();
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const payload = JSON.parse(download.mock.calls[0]![1]) as UsageJsonExport;
    expect(payload.sessions).toMatchObject([
      { key, sessionId, contextWeight: contextWeight(sessionId) },
    ]);
  },
);

it.each([false, true])("exports unchanged cohorts (tied agents: %s)", async (tiedAgents) => {
  const { result } = cacheSnapshot("fresh");
  const rows = [
    ...(tiedAgents ? [{ agentId: "B", model: "gamma", cost: 0.06 }] : []),
    { agentId: "A", model: "alpha", cost: 0.02 },
    { agentId: "A", model: "beta", cost: 0.01 },
    { agentId: "A", model: "alpha", cost: 0.03 },
  ].map(({ agentId, model, cost }, i) => ({
    key: `agent:${agentId}:session-${i}`,
    sessionId: `instance-${i}`,
    agentId,
    model,
    usage: usageTotals(1, cost),
  }));
  const dayBucket = { mode: "utc-offset", utcOffsetMinutes: 0 } as const;
  const cohorts = prepareUsageModelCohorts(rows, dayBucket);
  const selection = selectUsageModelCohorts(cohorts, {})!;
  const overview = buildUsageModelCohortReport(
    selection,
    {},
    dayBucket,
    rows.map((row) => compactUsageOverviewSession(row, new Set())),
  );
  const details = buildUsageOverview({ rows, options: {}, dayBucket, compact: false });
  expect(selection.cohorts).toHaveLength(tiedAgents ? 3 : 2);
  expect(overview.aggregates.byAgent.map((row) => row.agentId)).toEqual(
    tiedAgents ? ["A", "B"] : ["A"],
  );
  expect(details.aggregates.byAgent.map((row) => row.agentId)).toEqual(
    tiedAgents ? ["B", "A"] : ["A"],
  );

  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const { page } = await loadUsagePage(async (method: string, params?: { projection?: string }) =>
    method === "sessions.usage"
      ? { ...result, ...(params?.projection === "overview" ? overview : details) }
      : { providers: [] },
  );
  expect(page.read().filters.selectedSessions).toHaveLength(0);
  expect(page.read().data.totals?.totalCost).toBe(overview.totals.totalCost);
  await selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  const payload = JSON.parse(download.mock.calls[0]![1]) as UsageJsonExport;
  expect(payload.aggregates.byAgent).toEqual(details.aggregates.byAgent);
  expect(payload.sessions).toHaveLength(rows.length);
  expect(new Set(payload.sessions.map((row) => row.sessionId))).toEqual(
    new Set(rows.map((row) => row.sessionId)),
  );
  expect(payload.totals).toMatchObject({
    totalTokens: rows.length,
    totalCost: tiedAgents ? 0.12 : 0.06,
  });
});

it("exports the detailed latency percentile after refreshing the overview", async () => {
  const { result } = cacheSnapshot("fresh");
  const totals = usageTotals(101, 12.625);
  let count = 101;
  const { page } = await loadUsagePage(async (method: string, params?: { projection?: string }) => {
    if (method !== "sessions.usage") {
      return { providers: [] };
    }
    // Two quarters contain 100 replies at 100 ms and one at 10,000 ms, respectively.
    const latency = {
      count,
      minMs: 100,
      maxMs: 10_000,
      avgMs: 20_000 / 101,
      p95Ms: params?.projection === "overview" ? 10_000 : 100,
    };
    const sessions = [
      {
        key: "agent:main:notebook",
        sessionId: "notebook",
        usage: { ...totals, latency, dailyLatency: [{ date: result.startDate, ...latency }] },
      },
    ];
    return { ...result, sessions, totals, aggregates: buildAggregatesFromSessions(sessions) };
  });
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
  const exportJson = () => selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
  await page.refresh();
  await settleUsagePage(page);
  expect(page.read().data.aggregates?.latency?.p95Ms).toBe(10_000);
  await exportJson();
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  const payload = JSON.parse(download.mock.calls[0]![1]) as UsageJsonExport;
  expect(payload.aggregates.latency?.p95Ms).toBe(100);
  expect(payload.aggregates.dailyLatency).toMatchObject([{ date: result.startDate, p95Ms: 100 }]);
  expect(payload.sessions[0]?.usage?.latency?.p95Ms).toBe(100);

  count++;
  await exportJson();
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Refresh usage and try again") }),
    ),
  );
  expect(download).toHaveBeenCalledOnce();
});

it("requires a refresh when an unbilled message changes the displayed usage", async () => {
  const { result } = cacheSnapshot("fresh");
  let userMessages = 0;
  const read = () => {
    const row = {
      key: "agent:main:notebook",
      sessionId: "notebook",
      usage: {
        ...usageTotals(7, 0.75),
        messageCounts: {
          total: 1 + userMessages,
          user: userMessages,
          assistant: 1,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
      },
    };
    return {
      ...result,
      sessions: [row],
      totals: usageTotals(7, 0.75),
      aggregates: buildAggregatesFromSessions([row]),
    };
  };
  const { page } = await loadUsagePage(async (method: string) =>
    method === "sessions.usage" ? read() : { providers: [] },
  );
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
  const exportJson = () => selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
  expect(page.read().data.aggregates?.messages.total).toBe(1);
  userMessages++;
  await exportJson();
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Refresh usage and try again") }),
    ),
  );
  expect(download).not.toHaveBeenCalled();

  await page.refresh();
  await settleUsagePage(page);
  expect(page.read().data.aggregates?.messages.total).toBe(2);
  await exportJson();
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  const payload = JSON.parse(download.mock.calls[0]![1]) as UsageJsonExport;
  expect(payload.totals).toMatchObject({ totalTokens: 7, totalCost: 0.75 });
  expect(payload.sessions[0]).toMatchObject({
    sessionId: "notebook",
    usage: { messageCounts: { user: 1 } },
  });
  expect(payload.aggregates.messages.total).toBe(2);
});
