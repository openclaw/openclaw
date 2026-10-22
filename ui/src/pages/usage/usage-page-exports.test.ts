/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import * as downloads from "../../lib/download.ts";
import { selectUsageExport } from "./export-menu.test-support.ts";
import type { UsageJsonExport } from "./types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  loadUsagePage,
  queryUsagePage,
  settleUsagePage,
  usageCalls,
} from "./usage-page.test-support.ts";
import { texts } from "./view-render.test-support.ts";
import { buildAggregatesFromSessions } from "./view.test-support.ts";

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
      const trigger = page.querySelector<HTMLButtonElement>(
        '[id="usage-filter-provider:trigger"]',
      )!;
      trigger.click();
      await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      page
        .querySelector<HTMLButtonElement>(
          '[id="usage-filter-provider:content"] [data-value="option:openai"]',
        )!
        .click();
      await vi.waitFor(() =>
        expect(usageCalls(request).at(-1)?.[1]).toMatchObject({
          query: page.querySelector<HTMLInputElement>(".usage-query-input")!.value.trim(),
        }),
      );
      await settleUsagePage(page);
      trigger.click();
      expect
        .soft(page.querySelector<HTMLInputElement>(".usage-query-input")!.value)
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
