import { expect, it } from "vitest";
import {
  applyUsageCostEstimate,
  needsUsageCostEstimate,
  parseUsageCostTranscriptRecord,
} from "./session-cost-usage-pricing.js";

const flatPricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
const tier = (rate: number, range: [number, number]) => ({
  input: rate,
  output: rate * 2,
  cacheRead: rate / 2,
  cacheWrite: 0,
  range,
});
const tieredPricing = {
  ...flatPricing,
  tieredPricing: [tier(1, [0, 1_000]), tier(2, [1_000, 100_000])],
};
const latestCall = { state: "available", promptTokens: 600, totalTokens: 610 };
const call = (type: string, name: string) => ({ type, name });
function tools(
  name: string,
  message: Record<string, unknown> | unknown[],
  toolNames: string[],
  total = 0,
  errors = 0,
) {
  return {
    name,
    message: Array.isArray(message) ? { content: message } : message,
    toolNames,
    toolResultCounts: { total, errors },
  };
}

it.each([
  tools("trimmed primary name wins", { toolName: " weather ", tool_name: "ignored" }, ["weather"]),
  tools("legacy top-level alias", { tool_name: "notes" }, ["notes"]),
  tools(
    "canonical, padded and legacy call types",
    [
      call("tool_use", "read"),
      call("toolcall", "exec"),
      call("tool_call", "write"),
      call(" toolCall ", "padded"),
      call("toolUse", "legacy"),
      call("tool_call", ""),
    ],
    ["read", "exec", "write", "padded", "legacy"],
  ),
  tools("blank name ignores alias", { toolName: " ", tool_name: "ignored", content: [] }, []),
  tools(
    "mixed calls and recognized results with explicit errors",
    [
      null,
      "ignore",
      call("toolCall", "read"),
      { type: "tool_result" },
      { type: " TOOL_RESULT ", is_error: true },
      { type: "tool_result_error" },
      { type: "toolResult", is_error: true },
      { type: "text", text: "ignore" },
    ],
    ["read"],
    3,
    1,
  ),
  tools("non-array content", { content: "nope" }, []),
])("parses tool accounting for $name", ({ message, toolNames, toolResultCounts }) => {
  expect(
    parseUsageCostTranscriptRecord({ message: { role: "assistant", ...message } }),
  ).toMatchObject({ toolNames, toolResultCounts });
});

function estimate(usage: Record<string, unknown>, cost: typeof flatPricing) {
  const entry = parseUsageCostTranscriptRecord({ message: { role: "assistant", usage } });
  if (!needsUsageCostEstimate(entry)) {
    throw new Error("expected an unpriced usage entry");
  }
  return applyUsageCostEstimate(entry, () => cost).costTotal;
}

it.each([
  ["ambiguous multi-call tier", 1_200, tieredPricing, undefined],
  ["multi-call lowest tier", 900, tieredPricing, 0.00094],
  ["single-call tier", 600, tieredPricing, 0.00064],
])("%s", (_name, input, cost, expected) => {
  const total = estimate({ input, output: 20, contextUsage: latestCall }, cost);
  expect(total).toEqual(expected === undefined ? undefined : expect.closeTo(expected, 8));
});
