import { describe, it, expect } from "vitest";
import { resolveModelCostConfig } from "./usage-format.js";

describe("resolveModelCostConfig", () => {
  it("returns cost for exact match (gpt-4o)", () => {
    const cost = resolveModelCostConfig({ model: "gpt-4o" });
    expect(cost).toBeDefined();
    expect(cost?.input).toBe(2.5);
  });

  it("returns cost for fuzzy match (claude-3-5-sonnet)", () => {
    const cost = resolveModelCostConfig({ model: "anthropic/claude-3-5-sonnet-20240620" });
    expect(cost).toBeDefined();
    expect(cost?.input).toBe(3);
  });

  it("returns undefined for unknown model", () => {
    const cost = resolveModelCostConfig({ model: "unknown-model" });
    expect(cost).toBeUndefined();
  });

  it("prioritizes config override", () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-4o",
                cost: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const cost = resolveModelCostConfig({
      provider: "openai",
      model: "gpt-4o",
      config: config as any,
    });
    expect(cost?.input).toBe(100);
  });
});
