import { describe, expect, it } from "vitest";
import { sanitizeGoogleThinkingPayload } from "./google-thinking-payload.js";

type ThinkingCase = [
  modelId: string,
  thinkingLevel: Parameters<typeof sanitizeGoogleThinkingPayload>[0]["thinkingLevel"],
  initial: Record<string, unknown>,
  expected?: Record<string, unknown>,
  container?: "config" | "generationConfig",
];

const thoughts = { includeThoughts: true };
const budget = { thinkingBudget: 0 };

describe("sanitizeGoogleThinkingPayload", () => {
  it.each<ThinkingCase>([
    [
      "google/gemini-4-argon",
      undefined,
      { thinkingBudget: 8192, ...thoughts },
      { thinkingLevel: "MEDIUM", ...thoughts },
    ],
    ["gemini-4-argon", "off", budget, { thinkingLevel: "LOW" }],
    [
      "gemini-4-argon",
      "adaptive",
      { thinkingBudget: 8192, thinkingLevel: "HIGH", ...thoughts },
      thoughts,
    ],
    ["gemini-2.5-pro", undefined, budget],
    ["google/gemini-2.5-pro-preview", undefined, budget],
    ["gemini-2.5-pro", undefined, { ...budget, ...thoughts }, thoughts],
    ["gemini-2.5-pro", undefined, { ...budget, ...thoughts }, thoughts, "generationConfig"],
    ["gemini-2.5-flash", undefined, budget, budget],
    ["gemini-2.5-pro", undefined, { thinkingBudget: 1000 }, { thinkingBudget: 1000 }],
    [
      "gemini-3.1-pro-preview",
      "high",
      { thinkingBudget: 2048, ...thoughts },
      { ...thoughts, thinkingLevel: "HIGH" },
    ],
    ["gemini-flash-latest", "off", budget, { thinkingLevel: "MINIMAL" }, "generationConfig"],
    [
      "gemini-3-flash-preview",
      "medium",
      { thinkingBudget: -1, ...thoughts },
      { ...thoughts, thinkingLevel: "MEDIUM" },
    ],
    ["gemini-3-flash-preview", "adaptive", { thinkingBudget: 8192, ...thoughts }, thoughts],
    [
      "gemini-2.5-flash",
      "adaptive",
      { thinkingBudget: 8192, ...thoughts },
      { ...thoughts, thinkingBudget: -1 },
    ],
  ])(
    "normalizes %s / %s / %j",
    (modelId, thinkingLevel, initial, expected, container = "config") => {
      const config: { thinkingConfig?: Record<string, unknown> } = {
        thinkingConfig: { ...initial },
      };
      sanitizeGoogleThinkingPayload({ payload: { [container]: config }, modelId, thinkingLevel });
      if (expected === undefined) {
        expect(config).not.toHaveProperty("thinkingConfig");
      } else {
        expect(config.thinkingConfig).toEqual(expected);
      }
    },
  );
});
