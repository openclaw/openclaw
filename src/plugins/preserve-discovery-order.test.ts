import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  resolveProviderPluginsForHooks: vi.fn(),
}));

vi.mock("./provider-hook-runtime.js", () => ({
  resolveProviderPluginsForHooks: seams.resolveProviderPluginsForHooks,
}));

const {
  collectPreserveDiscoveryOrderProviders,
  resetPreserveDiscoveryOrderLookupLogForTest,
  resolvePreserveDiscoveryOrderProviders,
} = await import("./preserve-discovery-order.js");

describe("collectPreserveDiscoveryOrderProviders", () => {
  it("returns the normalized id, aliases, and hookAliases of every preserve-order plugin", () => {
    const set = collectPreserveDiscoveryOrderProviders([
      {
        id: "Curated",
        aliases: ["Curated-Alias"],
        hookAliases: ["curated-hook-alias"],
        catalog: { preserveDiscoveryOrder: true },
      },
      { id: "not-preserve", catalog: { preserveDiscoveryOrder: false } },
      { id: "no-catalog" },
    ]);
    expect([...set].toSorted()).toEqual(["curated", "curated-alias", "curated-hook-alias"]);
  });

  it("ignores plugins without preserveDiscoveryOrder=true", () => {
    const set = collectPreserveDiscoveryOrderProviders([
      { id: "a", catalog: { preserveDiscoveryOrder: false } },
      { id: "b" },
    ]);
    expect(set.size).toBe(0);
  });

  it("skips ids that normalize to empty", () => {
    const set = collectPreserveDiscoveryOrderProviders([
      {
        id: "curated",
        aliases: ["   ", ""],
        hookAliases: [],
        catalog: { preserveDiscoveryOrder: true },
      },
    ]);
    expect([...set]).toEqual(["curated"]);
  });
});

describe("resolvePreserveDiscoveryOrderProviders", () => {
  beforeEach(() => {
    seams.resolveProviderPluginsForHooks.mockReset();
    resetPreserveDiscoveryOrderLookupLogForTest();
  });

  it("delegates plugin lookup to resolveProviderPluginsForHooks and reduces the result", () => {
    seams.resolveProviderPluginsForHooks.mockReturnValue([
      {
        id: "curated",
        aliases: ["curated-alias"],
        hookAliases: [],
        catalog: { preserveDiscoveryOrder: true },
      },
      { id: "other", catalog: { preserveDiscoveryOrder: false } },
    ]);

    const set = resolvePreserveDiscoveryOrderProviders({});

    expect([...set].toSorted()).toEqual(["curated", "curated-alias"]);
    expect(seams.resolveProviderPluginsForHooks).toHaveBeenCalledOnce();
  });

  it("returns an empty set and swallows the error when plugin lookup throws", () => {
    seams.resolveProviderPluginsForHooks.mockImplementation(() => {
      throw new Error("plugin runtime broken");
    });

    const set = resolvePreserveDiscoveryOrderProviders({});

    expect(set.size).toBe(0);
  });
});
