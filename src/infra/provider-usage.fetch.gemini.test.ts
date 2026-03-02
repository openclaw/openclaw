import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchGeminiUsage } from "./provider-usage.fetch.gemini.js";

describe("fetchGeminiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "rate_limited" }),
    );
    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");

    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("selects the lowest remaining fraction per model family", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("Bearer token");

      return makeResponse(200, {
        buckets: [
          { modelId: "gemini-pro", remainingFraction: 0.8 },
          { modelId: "gemini-pro-preview", remainingFraction: 0.3 },
          { modelId: "gemini-flash", remainingFraction: 0.7 },
          { modelId: "gemini-flash-latest", remainingFraction: 0.9 },
          { modelId: "gemini-unknown", remainingFraction: 0.5 },
        ],
      });
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");

    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toEqual({ label: "Pro", usedPercent: 70 });
    expect(result.windows[1]?.label).toBe("Flash");
    expect(result.windows[1]?.usedPercent).toBeCloseTo(30, 6);
  });
});
