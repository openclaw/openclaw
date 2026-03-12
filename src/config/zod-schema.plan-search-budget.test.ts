import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema planSearch budget", () => {
  it("accepts positive plan-search budget limits", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        planSearch: {
          enabled: true,
          budget: {
            maxTokens: 2_048,
            maxRuntimeMs: 120_000,
            maxCostUsd: 0.05,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects non-positive plan-search budget limits", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        planSearch: {
          enabled: true,
          budget: {
            maxTokens: 0,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      AgentDefaultsSchema.parse({
        planSearch: {
          enabled: true,
          budget: {
            maxCostUsd: -0.01,
          },
        },
      }),
    ).toThrow();
  });
});
