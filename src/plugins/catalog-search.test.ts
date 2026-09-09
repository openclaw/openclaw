// Catalog boundary proof uses the real ClawHub HTTP client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubFetch } from "../infra/clawhub-client.js";
import { searchInstallablePluginPackages } from "./catalog-search.js";

beforeEach(() => {
  vi.stubEnv("CLAWHUB_TOKEN", "synthetic-clawhub-token");
  vi.stubEnv("CLAWHUB_DISABLE_TELEMETRY", "false");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("plugin catalog search", () => {
  it("returns one combined response for a marked search without adding identity metadata", async () => {
    const results = [
      { score: 9, package: { name: "calendar-bundle", family: "bundle-plugin", isOfficial: true } },
      { score: 4, package: { name: "calendar-code", family: "code-plugin", isOfficial: false } },
    ];
    const fetch = vi.fn<ClawHubFetch>(async () => Response.json({ results }));
    vi.stubGlobal("fetch", fetch);

    expect(
      await searchInstallablePluginPackages({
        query: " calendar ",
        limit: 2,
        searchSource: "openclaw-control-ui",
      }),
    ).toEqual(results);

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0]!;
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe("/api/v1/plugins/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "calendar",
      limit: "2",
      searchSource: "openclaw-control-ui",
    });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: "Bearer synthetic-clawhub-token",
    });
  });

  it("does not replay a marked search after a transport failure", async () => {
    const fetch = vi
      .fn<ClawHubFetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      searchInstallablePluginPackages({
        query: "calendar",
        searchSource: "openclaw-control-ui",
      }),
    ).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [Number.NaN, "20"],
    [101, "100"],
  ] as const)(
    "bounds unmarked programmatic limit %s without attributing demand",
    async (limit, expected) => {
      const fetch = vi.fn<ClawHubFetch>(async () => Response.json({ results: [] }));
      vi.stubGlobal("fetch", fetch);
      await searchInstallablePluginPackages({ query: "calendar", limit });
      expect(fetch).toHaveBeenCalledOnce();
      const [input] = fetch.mock.calls[0]!;
      const url = new URL(input instanceof Request ? input.url : input);
      expect(Object.fromEntries(url.searchParams)).toEqual({ q: "calendar", limit: expected });
    },
  );

  it("honors the existing telemetry opt-out without changing search results", async () => {
    vi.stubEnv("CLAWHUB_DISABLE_TELEMETRY", "true");
    const results = [
      { score: 2, package: { name: "calendar", family: "code-plugin", isOfficial: false } },
    ];
    const fetch = vi.fn<ClawHubFetch>(async () => Response.json({ results }));
    vi.stubGlobal("fetch", fetch);

    expect(
      await searchInstallablePluginPackages({
        query: "calendar",
        searchSource: "openclaw-control-ui",
      }),
    ).toEqual(results);
    expect(fetch).toHaveBeenCalledOnce();
    const [input] = fetch.mock.calls[0]!;
    const url = new URL(input instanceof Request ? input.url : input);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "calendar", limit: "20" });
  });
});
