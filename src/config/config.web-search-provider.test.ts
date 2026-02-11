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

  it("accepts zsearch provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "zsearch",
            zsearch: {
              apiKey: "test-zai-key",
              contentSize: "medium",
              location: "us",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts zsearch provider without config block", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            provider: "zsearch",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects invalid zsearch contentSize", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            provider: "zsearch",
            zsearch: {
              contentSize: "invalid",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
