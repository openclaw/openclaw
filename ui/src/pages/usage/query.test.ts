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

it("matches the full catalog before capping suggestions and preserves raw spelling", () => {
  const values = ["first", "second", "third", "fourth", "fifth", "sixth", "OpenAI", "openai"];
  const options = { agent: values, channel: values, provider: values, model: values, tool: values };
  const suggest = (query: string) =>
    buildQuerySuggestions(query, extractQueryTerms(query), options);
  for (const key of ["agent", "channel", "provider", "model", "tool"]) {
    for (const query of [`${key}:OPEN`, `"${key}:OPEN"`, `${key}:"OPEN"`]) {
      expect(suggest(query).map((entry) => entry.value)).toEqual([
        `${key}:OpenAI`,
        `${key}:openai`,
      ]);
    }
    expect(suggest(`${key}:`).map((entry) => entry.value)).toEqual(
      ["first", "second", "third", "fourth", "fifth", "sixth"].map((value) => `${key}:${value}`),
    );
    expect(suggest(`${key}:missing`)).toEqual([]);
  }
  expect(suggest("constructor:")).toEqual([]);
  expect(suggest("has:err")).toEqual([{ label: "has:errors", value: "has:errors" }]);
});

it.each([
  ["Local Model", 'model:"Local Model"'],
  ['Atlas "Mini Pro"', 'model:"Atlas ""Mini Pro"""'],
  ['A"B', 'model:"A""B"'],
])("keeps the selected model %s as one query term", (model, token) => {
  const query = setQueryTokensForKey("provider:local ", "model", [model]);
  expect(query).toBe(`provider:local ${token} `);
  expect(extractQueryTerms(query).map(({ key, value }) => ({ key, value }))).toEqual([
    { key: "provider", value: "local" },
    { key: "model", value: model },
  ]);
  // Reselecting keeps the existing quoted term instead of appending a duplicate.
  expect(setQueryTokensForKey(query, "model", [model])).toBe(query);

  const options = buildUsageFilterOptions([{ key: "session-1", model, usage: null }]);
  expect(buildQuerySuggestions("model:", extractQueryTerms("model:"), options)).toEqual([
    { label: `model:${model}`, value: token },
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
      cacheUnmeasuredInput: 0,
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
