import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("tools.web.fetch.firecrawl config schema", () => {
  it("accepts firecrawl nested config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              enabled: true,
              baseUrl: "http://localhost:3002",
              onlyMainContent: true,
              maxAgeMs: 172800000,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts readability config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          fetch: {
            readability: false,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
