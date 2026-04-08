import { describe, expect, it } from "vitest";
import { resolveBundledContractSnapshotPluginIds } from "./contracts/inventory/bundled-capability-metadata.js";
import { resolveManifestContractPluginIds } from "./manifest-registry.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

describe("web provider public artifacts", () => {
  it("covers every bundled web search provider declared in manifests", () => {
    expect(resolveBundledContractSnapshotPluginIds("webSearchProviderIds")).toEqual(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        origin: "bundled",
      }),
    );
  });

  it("covers every bundled web fetch provider declared in manifests", () => {
    expect(resolveBundledContractSnapshotPluginIds("webFetchProviderIds")).toEqual(
      resolveManifestContractPluginIds({
        contract: "webFetchProviders",
        origin: "bundled",
      }),
    );
  });

  it("loads a lightweight bundled web search artifact smoke", () => {
    const provider = resolveBundledWebSearchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
      onlyPluginIds: ["brave"],
    })?.[0];

    expect(provider?.pluginId).toBe("brave");
    expect(provider?.createTool({ config: {} as never })).toBeNull();
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
