// @vitest-environment node
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import {
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  removeQueryToken,
} from "./query.ts";
import type { UsageSessionEntry } from "./types.ts";
import { buildUsageFilterOptions } from "./view.test-support.ts";

it.each(['label:"Team  Planning"', '"label:Team  Planning"'])(
  "removes an entire quoted term without leaving phrase fragments: %s",
  (quotedLabel) => {
    expect(removeQueryToken(`${quotedLabel} provider:openai`, quotedLabel)).toBe(
      "provider:openai ",
    );
  },
);

it("limits suggestions before matching while preserving raw option spelling", () => {
  const values = [
    "OpenAI",
    "OpenAI",
    "openai",
    " ",
    "",
    undefined,
    "four",
    "five",
    "six",
    "seventh",
  ];
  const sessions = values.map((value, index) => ({
    key: `session-${index}`,
    agentId: value,
    channel: value,
    modelProvider: value,
    model: value,
    usage: null,
  }));
  const options = buildUsageFilterOptions(sessions);
  const suggest = (query: string) =>
    buildQuerySuggestions(query, extractQueryTerms(query), options);
  expect(options.agent).toEqual(["OpenAI", "openai", " ", "four", "five", "six"]);
  for (const key of ["agent", "channel", "provider", "model"]) {
    for (const query of [`${key}:OPEN`, `"${key}:OPEN"`, `${key}:"OPEN"`]) {
      expect(suggest(query).map((entry) => entry.value)).toEqual([
        `${key}:OpenAI`,
        `${key}:openai`,
      ]);
    }
    expect(suggest(`${key}:seventh`)).toEqual([]);
  }
  expect(suggest("constructor:")).toEqual([]);
  expect(suggest("has:err")).toEqual([{ label: "has:errors", value: "has:errors" }]);
});

const csvForLabel = (label: string, usage: UsageSessionEntry["usage"] = null) =>
  buildSessionsCsv([{ key: "session-1", label, updatedAt: 0, usage }]);
it("leaves unavailable numeric cells blank rather than exporting zero or a completed subtotal", () => {
  const usage = {
    ...createEmptyCostUsageTotals(),
    input: 50,
    totalTokens: 50,
    totalCost: 0.01,
    usageReport: { state: "unavailable" as const },
  };
  const daily = buildDailyCsv([{ date: "2026-10-11", ...usage }]);
  expect(daily.split("\n")[1]).toBe("2026-10-11,,,,,,,,,,");
  const sessions = buildSessionsCsv([{ key: "interrupted", usage }]);
  expect(sessions.split("\n")[1]?.split(",").slice(-6)).toEqual(Array(6).fill(""));
});

it("keeps daily headers aligned with numeric cells", () => {
  const csv = buildDailyCsv([
    {
      date: "2026-09-23",
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      inputCost: 0,
      outputCost: -2,
      cacheReadCost: 3,
      cacheWriteCost: 4,
      totalCost: -2,
      missingCostEntries: 2,
    },
  ]);
  expect(csv).toBe(
    "date,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,inputCost,outputCost,cacheReadCost,cacheWriteCost,totalCost\n" +
      "2026-09-23,1,2,3,4,10,0,-2,3,4,-2",
  );
});

it.each([
  ["leading whitespace", " \t=1+1", "' \t=1+1"],
  ["fullwidth equals", "\uFF1D1+1", "'\uFF1D1+1"],
  ["carriage return", "\r=1+1", '"\'\r=1+1"'],
])("neutralizes spreadsheet formula labels with %s prefix", (_name, label, expected) => {
  expect(csvForLabel(label)).toContain(`session-1,${expected},`);
});

it("keeps numeric cells numeric while neutralizing string labels", () => {
  const csv = csvForLabel("-remote-label", {
    ...createEmptyCostUsageTotals(),
    durationMs: -1,
    messageCounts: {
      total: -2,
      user: -3,
      assistant: -4,
      toolCalls: -5,
      toolResults: -6,
      errors: -7,
    },
    input: -5,
    output: -6,
    cacheRead: -7,
    cacheWrite: -8,
    totalTokens: -9,
    totalCost: -10,
  });

  expect(csv).toContain("session-1,'-remote-label,,,");
  expect(csv).toContain(",-1,-2,-7,-5,-5,-6,-7,-8,-9,-10");
});
