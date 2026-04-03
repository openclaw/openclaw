import { describe, expect, it } from "vitest";
import { statusSummaryRuntime } from "./status.summary.runtime.js";

describe("statusSummaryRuntime.resolveContextTokensForModel", () => {
  it("matches provider context window overrides across canonical provider aliases", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "z.ai": {
              models: [{ id: "glm-4.7", contextWindow: 123_456 }],
            },
          },
        },
      } as never,
      provider: "z-ai",
      model: "glm-4.7",
      fallbackContextTokens: 999,
    });

    expect(contextTokens).toBe(123_456);
  });
});
