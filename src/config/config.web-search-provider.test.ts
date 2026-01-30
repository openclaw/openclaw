import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
              baseUrl: "https://api.perplexity.ai",
              model: "perplexity/sonar-pro",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts qveris provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "qveris",
            qveris: {
              toolId: "xiaosu.smartsearch.search.retrieve.v2.6c50f296_domestic",
              apiKey: "test-key",
              baseUrl: "https://qveris.ai/api/v1",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts qveris provider with minimal config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            provider: "qveris",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
