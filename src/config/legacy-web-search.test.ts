import { describe, expect, it } from "vitest";
import { normalizeLegacyWebSearchConfig } from "./legacy-web-search.js";

describe("normalizeLegacyWebSearchConfig", () => {
  it("preserves citationRedirect during generic web search normalization", () => {
    const normalized = normalizeLegacyWebSearchConfig({
      tools: {
        web: {
          search: {
            provider: "gemini",
            citationRedirect: {
              ssrfPolicy: {
                allowRfc2544BenchmarkRange: true,
              },
            },
          },
        },
      },
    });

    expect(normalized).toEqual({
      tools: {
        web: {
          search: {
            provider: "gemini",
            citationRedirect: {
              ssrfPolicy: {
                allowRfc2544BenchmarkRange: true,
              },
            },
          },
        },
      },
    });
  });
});
