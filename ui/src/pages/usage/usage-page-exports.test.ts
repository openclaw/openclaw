/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as downloads from "../../lib/download.ts";
import type { UsageJsonExport } from "./types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  createPage,
  preloadUsage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

it.each([
  { name: "single selection", selected: ["first"], query: "", expected: ["first"], tokens: 100 },
  {
    name: "multiple selections",
    selected: ["first", "second"],
    query: "",
    expected: ["first", "second"],
    tokens: 400,
  },
  {
    name: "selection intersected with a query",
    selected: ["first", "second"],
    query: "provider:openai",
    expected: ["first"],
    tokens: 100,
  },
  {
    name: "query without a selection",
    selected: [],
    query: "provider:openai",
    expected: ["first", "third"],
    tokens: 300,
  },
  {
    name: "selection excluded by a query",
    selected: ["second"],
    query: "provider:openai",
    expected: [],
    tokens: 0,
  },
])("exports the displayed session scope: $name", async ({ selected, query, expected, tokens }) => {
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
      label,
      agentId: "main",
      sessionId: `${label}-instance`,
      modelProvider: index === 1 ? "anthropic" : "openai",
      updatedAt: 3 - index,
      hasContextWeight: true,
      usage: {
        ...totals,
        dailyBreakdown: [
          { ...totals, date: "2026-08-07", tokens: totalTokens, cost: totalTokens / 100 },
        ],
      },
    };
  });
  const result = { ...snapshot.result, sessions };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.usage") {
      return params?.includeContextWeight
        ? {
            ...result,
            sessions: sessions.map((session) =>
              Object.assign({}, session, {
                usage: { ...session.usage, totalTokens: 9999 },
                contextWeight: contextWeight(session.label),
              }),
            ),
          }
        : result;
    }
    return { providers: [], points: [], logs: [] };
  });
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
  await preloadUsage(page);
  for (const [index, label] of selected.entries()) {
    page
      .querySelector<HTMLButtonElement>(`.session-bar-selection[aria-label="${label}"]`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: index > 0 }));
    await page.updateComplete;
  }
  if (query) {
    const input = page.querySelector<HTMLInputElement>(".usage-query-input")!;
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.updateComplete;
  }
  // Selection narrows accounting and exports, not the roster available for comparison.
  expect(
    new Set([...page.querySelectorAll(".session-bar-row")].map((row) => row.getAttribute("title"))),
  ).toEqual(
    new Set(
      (query ? ["first", "third"] : ["first", "second", "third"]).map(
        (label) => `agent:main:${label}`,
      ),
    ),
  );
  const menu = page.querySelector(".usage-export-menu")!;
  for (const value of ["sessions-csv", "json"]) {
    expect(menu.querySelector(`[value="${value}"]`)!.hasAttribute("disabled")).toBe(
      expected.length === 0,
    );
  }
  if (expected.length === 0) {
    expect(download).not.toHaveBeenCalled();
    return;
  }
  for (const value of ["sessions-csv", "json"]) {
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
  }
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  const csv = download.mock.calls.find(([filename]) => filename.endsWith(".csv"))![1];
  const [header, ...rows] = csv.split("\n").map((row) => row.split(","));
  const keys = expected
    .map((label) => `agent:main:${label}`)
    .toSorted((a, b) => a.localeCompare(b));
  const rowKeys = rows.map(([key]) => {
    if (key === undefined) {
      throw new Error("Exported CSV row is missing its session key");
    }
    return key;
  });
  expect.soft(rowKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(keys);
  expect
    .soft(rows.reduce((sum, row) => sum + Number(row[header!.indexOf("totalTokens")]), 0))
    .toBe(tokens);
  const payload = JSON.parse(
    download.mock.calls.find(([filename]) => filename.endsWith(".json"))![1],
  ) as UsageJsonExport;
  expect
    .soft(payload.sessions.map((session) => session.key).toSorted((a, b) => a.localeCompare(b)))
    .toEqual(keys);
  expect(payload.totals?.totalTokens).toBe(tokens);
  expect(payload.daily.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(tokens);
  expect
    .soft(payload.sessions.reduce((sum, session) => sum + (session.usage?.totalTokens ?? 0), 0))
    .toBe(tokens);
  for (const session of payload.sessions) {
    expect(session.contextWeight).toEqual(contextWeight(session.label!));
  }
});
