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
