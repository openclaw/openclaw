// @vitest-environment node
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import {
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  removeQueryToken,
  setQueryTokensForKey,
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

it("quotes newly selected multiword values so they parse as one term", () => {
  const query = setQueryTokensForKey("provider:local ", "model", ["Local Model"]);
  expect(query).toBe('provider:local model:"Local Model" ');
  expect(extractQueryTerms(query).map(({ key, value }) => ({ key, value }))).toEqual([
    { key: "provider", value: "local" },
    { key: "model", value: "Local Model" },
  ]);
  // Reselecting keeps the existing quoted term instead of appending a duplicate.
  expect(setQueryTokensForKey(query, "model", ["Local Model"])).toBe(query);

  const options = buildUsageFilterOptions([
    { key: "session-1", model: "Local Model", usage: null },
  ]);
  expect(buildQuerySuggestions("model:Loc", extractQueryTerms("model:Loc"), options)).toEqual([
    { label: "model:Local Model", value: 'model:"Local Model"' },
  ]);
});

const csvForLabel = (label: string, usage: UsageSessionEntry["usage"] = null) =>
  buildSessionsCsv([{ key: "session-1", label, updatedAt: 0, usage }]);

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
