import { describe, expect, it } from "vitest";
import { resolveManifestContractPluginIds } from "./manifest-registry.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

describe("web provider public artifacts", () => {
  it("covers every bundled web search provider declared in manifests", () => {
    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
    });

    expect(providers).not.toBeNull();
    expect(
      providers
        ?.map((entry) => entry.pluginId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        origin: "bundled",
      }),
    );
  });

  it("covers every bundled web fetch provider declared in manifests", () => {
    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
    });

    expect(providers).not.toBeNull();
    expect(
      providers
        ?.map((entry) => entry.pluginId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(
      resolveManifestContractPluginIds({
        contract: "webFetchProviders",
        origin: "bundled",
      }),
    );
  });

  it("prefers lightweight bundled web fetch contract artifacts", () => {
    const provider = resolveBundledWebFetchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
      onlyPluginIds: ["firecrawl"],
    })?.[0];

    expect(provider?.pluginId).toBe("firecrawl");
    expect(provider?.createTool({ config: {} as never })).toBeNull();
  });
});
