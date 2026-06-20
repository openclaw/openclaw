import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchOpenRouterUsage } from "./provider-usage.fetch.openrouter.js";

describe("fetchOpenRouterUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(401, "unauthorized"));
    const result = await fetchOpenRouterUsage("key", 5000, mockFetch);

    expect(result.error).toBe("HTTP 401");
    expect(result.windows).toHaveLength(0);
  });

  it("builds a credits window when a limit is set", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        data: { limit: 100, limit_remaining: 75, usage: 25 },
      }),
    );

    const result = await fetchOpenRouterUsage("key", 5000, mockFetch);
    expect(result.provider).toBe("openrouter");
    expect(result.displayName).toBe("OpenRouter");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      label: "Credits",
      usedPercent: 25,
    });
  });

  it("returns no windows for pay-as-you-go keys (limit null)", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { data: { limit: null, usage: 12.5 } }),
    );

    const result = await fetchOpenRouterUsage("key", 5000, mockFetch);
    expect(result.windows).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
