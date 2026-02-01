import { describe, expect, it } from "vitest";

import { MoltbotSchema } from "./zod-schema.js";

describe("tools.web.fetch.firecrawl config schema", () => {
  it("accepts firecrawl nested config", () => {
    const res = MoltbotSchema.safeParse({
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

    expect(res.success).toBe(true);
  });

  it("accepts readability config", () => {
    const res = MoltbotSchema.safeParse({
      tools: {
        web: {
          fetch: {
            readability: false,
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
