import { describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  fetchLiveProviderModelIds,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";

describe("provider catalog malformed pagination", () => {
  it("reports incomplete pagination on malformed absolute next URL with no usable fallback", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          // Space in hostname makes this a genuinely invalid absolute URL.
          next: "http://exa mple.com/models?page=2",
          has_more: false,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("recovers malformed next URL via cursor fallback", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            next: "http://exa mple.com/models?page=2",
            next_cursor: "cursor-2",
            has_more: true,
          }),
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "model-b", object: "model" }], has_more: false }),
        ),
        finalUrl: "https://provider.example.test/v1/models?after=cursor-2",
        release,
      });

    // The malformed next URL is ignored; cursor-based pagination takes over.
    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://provider.example.test/v1/models?after=cursor-2",
    );
  });

  it("sets safe replay headers when final URL is unparseable", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
        }),
      ),
      // An unparseable finalUrl should trigger safe replay headers (conservative
      // cross-origin assumption), not crash.
      finalUrl: "http://exa mple.com/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual(["model-a"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });
});
