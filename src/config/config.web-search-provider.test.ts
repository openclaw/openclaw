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

  it("accepts searxng provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "searxng",
            searxng: {
              baseUrl: "http://searxng:8181",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts searxng provider without searxng config block", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "searxng",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown keys in searxng config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "searxng",
            searxng: {
              baseUrl: "http://searxng:8181",
              apiKey: "should-not-exist",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
