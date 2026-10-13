import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectModelReference } from "./model-reference-validation.js";

function inspect(cfg: OpenClawConfig, provider: string, model: string) {
  return inspectModelReference({ cfg, env: {}, ref: { provider, model } }).status;
}

describe("inspectModelReference", () => {
  it("classifies refs against manifest seed rows", () => {
    expect(inspect({}, "openai", "gpt-5.6-sol")).toBe("known");
    expect(inspect({}, "openai", "not-in-the-local-catalog")).toBe("unknown-model");
    expect(inspect({}, "no-such-provider", "no-such-model")).toBe("unknown-provider");
  });

  it("does not treat an unlisted id as unknown when the provider plans no catalog rows", () => {
    // OpenRouter declares runtime discovery and ships no manifest seed rows, so the
    // planned catalog has nothing for the membership check to compare against.
    expect(inspect({}, "openrouter", "openrouter/auto")).toBe("uncatalogued-provider");
    expect(inspect({}, "openrouter", "deepseek/deepseek-v4-pro")).toBe("uncatalogued-provider");
  });

  it("uses models.providers.<id>.models as the catalog baseline when present", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                id: "openrouter/auto",
                name: "Auto Router",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };
    expect(inspect(cfg, "openrouter", "openrouter/auto")).toBe("known");
    expect(inspect(cfg, "openrouter", "deepseek/deepseek-v4-pro")).toBe("unknown-model");
  });
});
