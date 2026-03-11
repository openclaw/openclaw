import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchKilocodeUsage } from "./provider-usage.fetch.kilocode.js";

describe("fetchKilocodeUsage", () => {
  it("returns HTTP error snapshot for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(401, "unauthorized"));
    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.error).toBe("HTTP 401");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP error snapshot for server errors", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(503, "unavailable"));
    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.error).toBe("HTTP 503");
    expect(result.windows).toHaveLength(0);
  });

  it("returns balance as plan label when account is active", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { balance: 19.604203, isDepleted: false }),
    );

    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.provider).toBe("kilocode");
    expect(result.displayName).toBe("Kilo");
    expect(result.plan).toBe("$19.60");
    expect(result.windows).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it("returns depleted error when isDepleted is true", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { balance: 0, isDepleted: true }),
    );

    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.provider).toBe("kilocode");
    expect(result.plan).toBe("$0.00");
    expect(result.error).toBe("Depleted");
    expect(result.windows).toHaveLength(0);
  });

  it("handles missing balance field gracefully", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { isDepleted: false }),
    );

    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.plan).toBeUndefined();
    expect(result.windows).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it("rounds balance to two decimal places", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, { balance: 100, isDepleted: false }),
    );

    const result = await fetchKilocodeUsage("key", 5000, mockFetch);
    expect(result.plan).toBe("$100.00");
  });

  it("returns error snapshot for invalid JSON response", async () => {
    const mockFetch = createProviderUsageFetch(async () => {
      const res = new Response("not-json", { status: 200 });
      return res;
    });

    const result = await fetchKilocodeUsage("key", 5000, mockFetch);

    expect(result.error).toBe("Invalid JSON");
    expect(result.windows).toHaveLength(0);
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      capturedInit = init;
      return makeResponse(200, { balance: 5.0, isDepleted: false });
    });

    await fetchKilocodeUsage("test-api-key", 5000, mockFetch);

    expect((capturedInit?.headers as Record<string, string>)?.["Authorization"]).toBe(
      "Bearer test-api-key",
    );
  });
});
