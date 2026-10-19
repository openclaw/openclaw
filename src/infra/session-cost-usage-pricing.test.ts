import { expect, it } from "vitest";
import {
  applyUsageCostEstimate,
  needsUsageCostEstimate,
  parseUsageCostTranscriptRecord,
} from "./session-cost-usage-pricing.js";

const flatPricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
const tieredPricing = {
  ...flatPricing,
  tieredPricing: [
    { ...flatPricing, range: [0, 1_000] as [number, number] },
    {
      input: 2,
      output: 4,
      cacheRead: 1,
      cacheWrite: 0,
      range: [1_000, 100_000] as [number, number],
    },
  ],
};
const latestCall = { state: "available", promptTokens: 600, totalTokens: 610 };

it.each([
  {
    name: "trimmed top-level name",
    message: { toolName: " weather " },
    toolNames: ["weather"],
    toolResultCounts: { total: 0, errors: 0 },
  },
  {
    name: "legacy top-level alias",
    message: { tool_name: "notes" },
    toolNames: ["notes"],
    toolResultCounts: { total: 0, errors: 0 },
  },
  {
    name: "canonical, padded and legacy call types",
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "read" },
        { type: "toolcall", name: "exec" },
        { type: "tool_call", name: "write" },
        { type: " toolCall ", name: "padded" },
        { type: "toolUse", name: "legacy" },
      ],
    },
    toolNames: ["read", "exec", "write", "padded", "legacy"],
    toolResultCounts: { total: 0, errors: 0 },
  },
  {
    name: "one legacy mirror and repeated calls",
    message: {
      toolName: " write ",
      tool_name: "ignored",
      content: [
        { type: "toolCall", name: "read" },
        { type: "toolUse", name: "write" },
        { type: "tooluse", name: "write" },
        { type: "tool_call", name: "" },
      ],
    },
    toolNames: ["write", "read", "write"],
    toolResultCounts: { total: 0, errors: 0 },
  },
  {
    name: "blank primary name does not fall back to its alias",
    message: { toolName: " ", tool_name: "ignored", content: [] },
    toolNames: [],
    toolResultCounts: { total: 0, errors: 0 },
  },
  {
    name: "mixed calls and recognized results with explicit errors",
    message: {
      content: [
        null,
        "ignore",
        { type: "toolCall", name: "read" },
        { type: "tool_result" },
        { type: " TOOL_RESULT ", is_error: true },
        { type: "tool_result_error" },
        { type: "toolResult", is_error: true },
        { type: "text", text: "ignore" },
      ],
    },
    toolNames: ["read"],
    toolResultCounts: { total: 3, errors: 1 },
  },
  {
    name: "non-array content",
    message: { content: "nope" },
    toolNames: [],
    toolResultCounts: { total: 0, errors: 0 },
  },
])("parses tool accounting for $name", ({ message, toolNames, toolResultCounts }) => {
  expect(
    parseUsageCostTranscriptRecord({ message: { role: "assistant", ...message } }),
  ).toMatchObject({
    toolNames,
    toolResultCounts,
  });
});

function estimate(usage: Record<string, unknown>, cost: typeof flatPricing) {
  const entry = parseUsageCostTranscriptRecord({ message: { role: "assistant", usage } });
  if (!needsUsageCostEstimate(entry)) {
    throw new Error("expected an unpriced usage entry");
  }
  return applyUsageCostEstimate(entry, () => cost).costTotal;
}

it.each([
  // Two 600-token calls sum past the tier boundary that neither call crossed.
  [
    "leaves a multi-call turn unpriced when its sum crosses a tier",
    1_200,
    tieredPricing,
    undefined,
  ],
  ["prices a multi-call turn whose sum stays in the lowest tier", 900, tieredPricing, 0.00094],
  ["prices a multi-call turn under flat pricing", 1_200, flatPricing, 0.00124],
  ["prices a single-call turn from its own tier", 600, tieredPricing, 0.00064],
])("%s", (_name, input, cost, expected) => {
  const total = estimate({ input, output: 20, contextUsage: latestCall }, cost);
  if (expected === undefined) {
    expect(total).toBeUndefined();
  } else {
    expect(total).toBeCloseTo(expected, 8);
  }
});
