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

  it("accepts brave llm-context config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            brave: {
              mode: "llm-context",
              llmContext: {
                maxTokens: 16384,
                maxUrls: 10,
                thresholdMode: "strict",
                maxSnippets: 50,
                maxTokensPerUrl: 4096,
                maxSnippetsPerUrl: 5,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts brave web mode (default)", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            provider: "brave",
            brave: { mode: "web" },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects brave llm-context maxTokens below minimum", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            brave: {
              mode: "llm-context",
              llmContext: { maxTokens: 512 },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects brave llm-context maxTokens above maximum", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            brave: {
              mode: "llm-context",
              llmContext: { maxTokens: 65536 },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects unknown keys in brave config (strict mode)", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            brave: {
              mode: "llm-context",
              unknownKey: true,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects unknown keys in brave llmContext config (strict mode)", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            brave: {
              llmContext: {
                maxTokens: 8192,
                unknownKey: true,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
